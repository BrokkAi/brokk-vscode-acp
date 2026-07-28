mod client_io;
mod registry;

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    AgentCapabilities, AuthCapabilities, AuthMethod, AuthenticateRequest, CancelNotification,
    ClientCapabilities, ContentBlock, CreateTerminalRequest, DeleteSessionRequest,
    FileSystemCapabilities, Implementation, InitializeRequest, KillTerminalRequest,
    ListSessionsRequest, LoadSessionRequest, NewSessionRequest, PromptRequest, ReadTextFileRequest,
    ReleaseTerminalRequest, RequestPermissionRequest, ResumeSessionRequest,
    SessionConfigOptionValue, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, TerminalOutputRequest, TextContent, WaitForTerminalExitRequest,
    WriteTextFileRequest,
};
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectTo, ConnectionTo};
use anyhow::{Context, Result, anyhow};
use client_io::{PermissionBroker, WorkspaceIo};
use registry::{DEFAULT_REGISTRY_URL, LaunchSpec};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, Command};
use tokio::sync::mpsc;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

static EVENTS: OnceLock<mpsc::UnboundedSender<Value>> = OnceLock::new();
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(30);
const SESSION_LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(60);
const SESSION_LIST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_AGENT_STDERR_BYTES: usize = 12 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum HostCommand {
    ListAgents {
        storage_dir: PathBuf,
        #[serde(default = "default_registry_url")]
        registry_url: String,
    },
    InstallAgent {
        agent_id: String,
        storage_dir: PathBuf,
        #[serde(default = "default_registry_url")]
        registry_url: String,
    },
    Connect {
        command: PathBuf,
        #[serde(default)]
        args: Vec<String>,
        cwd: PathBuf,
        #[serde(default)]
        env: HashMap<String, String>,
        #[serde(default)]
        session: SessionSelection,
    },
    NewSession,
    OpenSession {
        session_id: String,
        #[serde(default = "default_true")]
        replay: bool,
    },
    RefreshSessions,
    DeleteSession {
        session_id: String,
    },
    Prompt {
        text: String,
    },
    Cancel,
    Authenticate {
        method_id: String,
    },
    RetrySession,
    PermissionResponse {
        request_id: String,
        #[serde(default)]
        option_id: Option<String>,
    },
    SetConfig {
        config_id: String,
        value: Value,
    },
    Disconnect,
}

#[derive(Debug, Default, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
enum SessionSelection {
    #[default]
    Browse,
    New,
    Open {
        session_id: String,
        #[serde(default = "default_true")]
        replay: bool,
    },
}

fn default_registry_url() -> String {
    DEFAULT_REGISTRY_URL.to_owned()
}

fn default_true() -> bool {
    true
}

#[tokio::main]
async fn main() -> Result<()> {
    let (command_tx, command_rx) = mpsc::unbounded_channel();
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Value>();
    EVENTS
        .set(event_tx.clone())
        .map_err(|_| anyhow!("event channel was already initialized"))?;

    let input_events = event_tx.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => match serde_json::from_str::<HostCommand>(&line) {
                    Ok(command) => {
                        if command_tx.send(command).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = input_events.send(json!({
                            "type": "error",
                            "message": format!("invalid host command: {error}")
                        }));
                    }
                },
                Ok(None) => break,
                Err(error) => {
                    let _ = input_events.send(json!({
                        "type": "error",
                        "message": format!("could not read extension input: {error}")
                    }));
                    break;
                }
            }
        }
    });

    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(event) = event_rx.recv().await {
            let mut encoded = serde_json::to_vec(&event)?;
            encoded.push(b'\n');
            stdout.write_all(&encoded).await?;
            stdout.flush().await?;
        }
        Ok::<_, anyhow::Error>(())
    });

    let result = run(command_rx).await;
    writer.abort();
    let _ = writer.await;
    if let Err(error) = result {
        write_event(&json!({ "type": "error", "message": format!("{error:#}") })).await?;
    }
    Ok(())
}

async fn write_event(value: &Value) -> Result<()> {
    let mut stdout = tokio::io::stdout();
    let mut encoded = serde_json::to_vec(value)?;
    encoded.push(b'\n');
    stdout.write_all(&encoded).await?;
    stdout.flush().await?;
    Ok(())
}

async fn emit(value: &Value) -> Result<()> {
    EVENTS
        .get()
        .context("event channel is not initialized")?
        .send(value.clone())
        .map_err(|_| anyhow!("extension output closed"))
}

struct ActiveConnection {
    id: u64,
    commands: mpsc::UnboundedSender<HostCommand>,
    task: tokio::task::JoinHandle<()>,
}

struct ConnectionFinished {
    id: u64,
    result: std::result::Result<(), String>,
}

async fn run(mut commands: mpsc::UnboundedReceiver<HostCommand>) -> Result<()> {
    let (finished_tx, mut finished_rx) = mpsc::unbounded_channel::<ConnectionFinished>();
    let mut active: Option<ActiveConnection> = None;
    let mut next_connection_id = 1_u64;

    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else {
                    if let Some(connection) = active.take() {
                        connection.task.abort();
                    }
                    break;
                };
                match command {
                    HostCommand::ListAgents {
                        storage_dir,
                        registry_url,
                    } => {
                        tokio::spawn(async move {
                            if let Err(error) = list_agents(&registry_url, &storage_dir).await {
                                let _ = emit_error(error).await;
                            }
                        });
                    }
                    HostCommand::InstallAgent {
                        agent_id,
                        storage_dir,
                        registry_url,
                    } => {
                        tokio::spawn(async move {
                            if let Err(error) =
                                install_agent(&registry_url, &storage_dir, &agent_id).await
                            {
                                let _ = emit_error(error).await;
                            }
                        });
                    }
                    HostCommand::Connect {
                        command,
                        args,
                        cwd,
                        env,
                        session,
                    } => {
                        if let Some(connection) = active.take() {
                            connection.task.abort();
                            emit(&json!({
                                "type": "disconnected",
                                "connection_id": connection.id,
                                "reason": "replaced",
                            }))
                            .await?;
                        }

                        let connection_id = next_connection_id;
                        next_connection_id = next_connection_id.saturating_add(1);
                        let launch = LaunchSpec { command, args, env };
                        emit(&json!({
                            "type": "connecting",
                            "connection_id": connection_id,
                            "command": launch.command,
                        }))
                        .await?;

                        let (connection_commands, mut connection_command_rx) =
                            mpsc::unbounded_channel();
                        let connection_finished = finished_tx.clone();
                        let task = tokio::spawn(async move {
                            let result =
                                run_connection(
                                    connection_id,
                                    launch,
                                    cwd,
                                    session,
                                    &mut connection_command_rx,
                                )
                                .await
                                .map_err(|error| format!("{error:#}"));
                            let _ = connection_finished.send(ConnectionFinished {
                                id: connection_id,
                                result,
                            });
                        });
                        active = Some(ActiveConnection {
                            id: connection_id,
                            commands: connection_commands,
                            task,
                        });
                    }
                    HostCommand::Disconnect => {
                        if let Some(connection) = active.take() {
                            connection.task.abort();
                            emit(&json!({
                                "type": "disconnected",
                                "connection_id": connection.id,
                                "reason": "requested",
                            }))
                            .await?;
                        }
                    }
                    command => {
                        let Some(connection) = active.as_ref() else {
                            emit(&json!({
                                "type": "error",
                                "message": "connect to an ACP agent before sending session commands"
                            }))
                            .await?;
                            continue;
                        };
                        if connection.commands.send(command).is_err() {
                            emit(&json!({
                                "type": "error",
                                "connection_id": connection.id,
                                "message": "the ACP connection is no longer accepting commands"
                            }))
                            .await?;
                        }
                    }
                }
            }
            finished = finished_rx.recv() => {
                let Some(finished) = finished else {
                    continue;
                };
                if active.as_ref().is_none_or(|connection| connection.id != finished.id) {
                    continue;
                }
                active = None;
                if let Err(message) = finished.result {
                    emit(&json!({
                        "type": "error",
                        "connection_id": finished.id,
                        "message": message,
                    }))
                    .await?;
                }
                emit(&json!({
                    "type": "disconnected",
                    "connection_id": finished.id,
                    "reason": "closed",
                }))
                .await?;
            }
        }
    }
    Ok(())
}

async fn list_agents(registry_url: &str, storage_dir: &Path) -> Result<()> {
    emit(&json!({ "type": "catalog_loading" })).await?;
    let (catalog, cached) = registry::fetch_registry(registry_url, storage_dir).await?;
    let agents = registry::summarize(&catalog, storage_dir);
    emit(&json!({
        "type": "catalog",
        "registry_version": catalog.version,
        "cached": cached,
        "agents": agents,
    }))
    .await
}

async fn install_agent(registry_url: &str, storage_dir: &Path, agent_id: &str) -> Result<()> {
    emit(&json!({
        "type": "installing_agent",
        "agent_id": agent_id,
    }))
    .await?;
    let (catalog, _) = registry::fetch_registry(registry_url, storage_dir).await?;
    let launch = registry::install(&catalog, agent_id, storage_dir).await?;
    emit(&json!({
        "type": "agent_installed",
        "agent_id": agent_id,
        "launch": launch,
    }))
    .await?;
    let agents = registry::summarize(&catalog, storage_dir);
    emit(&json!({
        "type": "catalog",
        "registry_version": catalog.version,
        "cached": false,
        "agents": agents,
    }))
    .await
}

async fn emit_error(error: anyhow::Error) -> Result<()> {
    emit(&json!({
        "type": "error",
        "message": format!("{error:#}")
    }))
    .await
}

async fn run_connection(
    connection_id: u64,
    launch: LaunchSpec,
    cwd: PathBuf,
    session: SessionSelection,
    commands: &mut mpsc::UnboundedReceiver<HostCommand>,
) -> Result<()> {
    let workspace = WorkspaceIo::new(&cwd)?;
    let permissions = PermissionBroker::default();
    let mut child = Command::new(&launch.command)
        .args(&launch.args)
        .current_dir(&cwd)
        .envs(&launch.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("could not start ACP agent `{}`", launch.command.display()))?;
    let child_stdin = child.stdin.take().context("agent stdin was not piped")?;
    let child_stdout = child.stdout.take().context("agent stdout was not piped")?;
    let child_stderr = child.stderr.take().context("agent stderr was not piped")?;
    let stderr_tail = Arc::new(Mutex::new(Vec::new()));
    let stderr_task = tokio::spawn(capture_agent_stderr(child_stderr, stderr_tail.clone()));
    let transport = ByteStreams::new(child_stdin.compat_write(), child_stdout.compat());

    emit(&json!({
        "type": "connection_progress",
        "connection_id": connection_id,
        "stage": "initialize",
        "message": "Agent process started. Waiting for the ACP handshake…",
    }))
    .await?;

    let client = drive_client(
        transport,
        connection_id,
        cwd,
        launch,
        session,
        commands,
        workspace.clone(),
        permissions.clone(),
    );
    tokio::pin!(client);

    enum ConnectionOutcome {
        Client(Result<()>),
        AgentExited(std::io::Result<ExitStatus>),
    }

    let outcome = tokio::select! {
        biased;
        status = child.wait() => ConnectionOutcome::AgentExited(status),
        result = &mut client => ConnectionOutcome::Client(result),
    };

    permissions.cancel_all().await;
    workspace.shutdown().await;
    let result = match outcome {
        ConnectionOutcome::Client(result) => {
            let _ = child.kill().await;
            let _ = stderr_task.await;
            result
        }
        ConnectionOutcome::AgentExited(status) => {
            let _ = stderr_task.await;
            let status = status.context("could not read ACP agent exit status")?;
            Err(agent_exit_error(status, &stderr_tail))
        }
    };
    result
}

async fn drive_client<T>(
    transport: T,
    connection_id: u64,
    cwd: PathBuf,
    launch: LaunchSpec,
    session: SessionSelection,
    commands: &mut mpsc::UnboundedReceiver<HostCommand>,
    workspace: WorkspaceIo,
    permissions: PermissionBroker,
) -> Result<()>
where
    T: ConnectTo<Client>,
{
    let permission_handler = permissions.clone();
    let read_handler = workspace.clone();
    let write_handler = workspace.clone();
    let create_terminal_handler = workspace.clone();
    let terminal_output_handler = workspace.clone();
    let release_terminal_handler = workspace.clone();
    let wait_terminal_handler = workspace.clone();
    let kill_terminal_handler = workspace.clone();

    Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                emit_session_update(notification.update).await;
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                responder.respond(permission_handler.request(request).await)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ReadTextFileRequest, responder, _connection| match read_handler
                .read_text_file(request)
                .await
            {
                Ok(response) => responder.respond(response),
                Err(error) => responder.respond_with_internal_error(error),
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: WriteTextFileRequest, responder, _connection| match write_handler
                .write_text_file(request)
                .await
            {
                Ok(response) => responder.respond(response),
                Err(error) => responder.respond_with_internal_error(error),
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: CreateTerminalRequest, responder, _connection| {
                match create_terminal_handler.create_terminal(request).await {
                    Ok(response) => responder.respond(response),
                    Err(error) => responder.respond_with_internal_error(error),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: TerminalOutputRequest, responder, _connection| {
                match terminal_output_handler.terminal_output(request).await {
                    Ok(response) => responder.respond(response),
                    Err(error) => responder.respond_with_internal_error(error),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ReleaseTerminalRequest, responder, _connection| {
                match release_terminal_handler.release_terminal(request).await {
                    Ok(response) => responder.respond(response),
                    Err(error) => responder.respond_with_internal_error(error),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: WaitForTerminalExitRequest, responder, _connection| {
                match wait_terminal_handler.wait_for_terminal(request).await {
                    Ok(response) => responder.respond(response),
                    Err(error) => responder.respond_with_internal_error(error),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: KillTerminalRequest, responder, _connection| {
                match kill_terminal_handler.kill_terminal(request).await {
                    Ok(response) => responder.respond(response),
                    Err(error) => responder.respond_with_internal_error(error),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(transport, |connection: ConnectionTo<Agent>| async move {
            drive_session(
                connection,
                connection_id,
                cwd,
                launch,
                session,
                commands,
                permissions,
            )
            .await
            .map_err(|error| {
                agent_client_protocol::Error::internal_error()
                    .data(Value::String(format!("{error:#}")))
            })
        })
        .await
        .map_err(|error| anyhow!("ACP connection failed: {error}"))
}

async fn drive_session(
    connection: ConnectionTo<Agent>,
    connection_id: u64,
    cwd: PathBuf,
    launch: LaunchSpec,
    initial_session: SessionSelection,
    commands: &mut mpsc::UnboundedReceiver<HostCommand>,
    permissions: PermissionBroker,
) -> Result<()> {
    let capabilities = ClientCapabilities::new()
        .fs(FileSystemCapabilities::new()
            .read_text_file(true)
            .write_text_file(true))
        .terminal(true)
        .auth(AuthCapabilities::new().terminal(true));
    let response = connection
        .send_request(
            InitializeRequest::new(ProtocolVersion::V1)
                .client_info(Implementation::new(
                    "brokk-vscode-acp",
                    env!("CARGO_PKG_VERSION"),
                ))
                .client_capabilities(capabilities),
        )
        .block_task();
    let response = tokio::time::timeout(INITIALIZE_TIMEOUT, response)
        .await
        .context("agent initialize timed out")?
        .context("agent rejected initialize")?;
    let auth_methods = response.auth_methods.clone();
    let agent_capabilities = response.agent_capabilities.clone();

    emit(&json!({
        "type": "connected",
        "connection_id": connection_id,
        "agent": response.agent_info.map(|info| info.name),
        "protocol_version": response.protocol_version,
        "agent_capabilities": agent_capabilities,
        "auth_methods": auth_methods,
    }))
    .await?;

    let mut active_session = match initial_session {
        SessionSelection::Browse => {
            emit_connection_progress(
                connection_id,
                "sessions",
                "ACP connected. Loading available sessions…",
            )
            .await?;
            report_session_list(&connection, &cwd, &agent_capabilities).await?;
            None
        }
        selection => {
            start_session(
                &connection,
                &cwd,
                &launch,
                &auth_methods,
                &agent_capabilities,
                selection,
                connection_id,
                commands,
            )
            .await?
        }
    };

    while let Some(command) = commands.recv().await {
        match command {
            HostCommand::NewSession => {
                active_session = start_session(
                    &connection,
                    &cwd,
                    &launch,
                    &auth_methods,
                    &agent_capabilities,
                    SessionSelection::New,
                    connection_id,
                    commands,
                )
                .await?;
            }
            HostCommand::OpenSession { session_id, replay } => {
                active_session = start_session(
                    &connection,
                    &cwd,
                    &launch,
                    &auth_methods,
                    &agent_capabilities,
                    SessionSelection::Open { session_id, replay },
                    connection_id,
                    commands,
                )
                .await?;
            }
            HostCommand::RefreshSessions => {
                report_session_list(&connection, &cwd, &agent_capabilities).await?;
            }
            HostCommand::DeleteSession { session_id } => {
                if active_session
                    .as_ref()
                    .is_some_and(|active| active.id.to_string() == session_id)
                {
                    emit(&json!({
                        "type": "error",
                        "message": "switch away from the active session before deleting it"
                    }))
                    .await?;
                    continue;
                }
                delete_session(&connection, &session_id, &agent_capabilities).await?;
                report_session_list(&connection, &cwd, &agent_capabilities).await?;
            }
            HostCommand::Prompt { text } => {
                let Some(session) = active_session.as_ref() else {
                    emit(&json!({
                        "type": "error",
                        "message": "start or open a session before prompting"
                    }))
                    .await?;
                    continue;
                };
                let session_id = session.id.clone();
                emit(&json!({
                    "type": "turn_started",
                    "session_id": session_id,
                }))
                .await?;
                let prompt = vec![ContentBlock::Text(TextContent::new(text))];
                let request = PromptRequest::new(session_id.clone(), prompt);
                let mut task = Box::pin(connection.send_request(request).block_task());
                loop {
                    tokio::select! {
                        result = &mut task => {
                            permissions.cancel_all().await;
                            match result {
                                Ok(response) => emit(&json!({
                                    "type": "turn_completed",
                                    "stop_reason": response.stop_reason,
                                    "usage": response.usage,
                                })).await?,
                                Err(error) => emit(&json!({
                                    "type": "error",
                                    "message": format!("prompt failed: {error}")
                                })).await?,
                            }
                            break;
                        }
                        command = commands.recv() => match command {
                            Some(HostCommand::Cancel) => {
                                permissions.cancel_all().await;
                                connection
                                    .send_notification(CancelNotification::new(session_id.clone()))
                                    .context("could not cancel prompt")?;
                            }
                            Some(HostCommand::PermissionResponse { request_id, option_id }) => {
                                if !permissions.resolve(&request_id, option_id).await {
                                    emit(&json!({
                                        "type": "error",
                                        "message": "permission request is no longer active"
                                    })).await?;
                                }
                            }
                            Some(HostCommand::Disconnect) | None => {
                                permissions.cancel_all().await;
                                return Ok(());
                            }
                            Some(_) => {
                                emit(&json!({
                                    "type": "error",
                                    "message": "a prompt is already running"
                                })).await?;
                            }
                        }
                    }
                }
            }
            HostCommand::SetConfig { config_id, value } => {
                let Some(session) = active_session.as_ref() else {
                    emit(&json!({
                        "type": "error",
                        "message": "start or open a session before changing configuration"
                    }))
                    .await?;
                    continue;
                };
                let value: SessionConfigOptionValue =
                    serde_json::from_value(value).context("invalid session configuration value")?;
                let response = tokio::time::timeout(
                    SESSION_LIFECYCLE_TIMEOUT,
                    connection
                        .send_request(SetSessionConfigOptionRequest::new(
                            session.id.clone(),
                            config_id,
                            value,
                        ))
                        .block_task(),
                )
                .await
                .context("agent session/set_config_option timed out")?
                .context("agent rejected session configuration change")?;
                emit(&json!({
                    "type": "config_options",
                    "config_options": response.config_options,
                }))
                .await?;
            }
            HostCommand::PermissionResponse {
                request_id,
                option_id,
            } => {
                if !permissions.resolve(&request_id, option_id).await {
                    emit(&json!({
                        "type": "error",
                        "message": "permission request is no longer active"
                    }))
                    .await?;
                }
            }
            HostCommand::Cancel => {}
            HostCommand::Disconnect => break,
            _ => {
                emit(&json!({ "type": "error", "message": "already connected" })).await?;
            }
        }
    }
    Ok(())
}

#[derive(Debug)]
struct ActiveSession {
    id: SessionId,
}

async fn start_session(
    connection: &ConnectionTo<Agent>,
    cwd: &Path,
    launch: &LaunchSpec,
    auth_methods: &[AuthMethod],
    capabilities: &AgentCapabilities,
    selection: SessionSelection,
    connection_id: u64,
    commands: &mut mpsc::UnboundedReceiver<HostCommand>,
) -> Result<Option<ActiveSession>> {
    let progress_message = match &selection {
        SessionSelection::Browse => return Ok(None),
        SessionSelection::New => "ACP connected. Creating a new session…",
        SessionSelection::Open { replay: true, .. } => {
            "ACP connected. Loading the session and transcript…"
        }
        SessionSelection::Open { .. } => "ACP connected. Resuming the session…",
    };
    emit_connection_progress(connection_id, "session", progress_message).await?;

    let (requested_id, replay) = match &selection {
        SessionSelection::Browse => unreachable!(),
        SessionSelection::New => (None, false),
        SessionSelection::Open { session_id, replay } => (Some(session_id.clone()), *replay),
    };

    if replay && requested_id.is_some() {
        emit(&json!({
            "type": "session_replay_started",
            "session_id": requested_id,
        }))
        .await?;
    }

    loop {
        let result = match &selection {
            SessionSelection::Browse => unreachable!(),
            SessionSelection::New => {
                let response = tokio::time::timeout(
                    SESSION_LIFECYCLE_TIMEOUT,
                    connection
                        .send_request(NewSessionRequest::new(cwd.to_path_buf()))
                        .block_task(),
                )
                .await
                .context("agent session/new timed out")?;
                response.map(|response| {
                    (
                        response.session_id,
                        response.config_options,
                        response.modes,
                        "new",
                    )
                })
            }
            SessionSelection::Open {
                session_id,
                replay: true,
            } if capabilities.load_session => {
                let response = tokio::time::timeout(
                    SESSION_LIFECYCLE_TIMEOUT,
                    connection
                        .send_request(LoadSessionRequest::new(
                            session_id.clone(),
                            cwd.to_path_buf(),
                        ))
                        .block_task(),
                )
                .await
                .context("agent session/load timed out")?;
                response.map(|response| {
                    (
                        SessionId::new(session_id.clone()),
                        response.config_options,
                        response.modes,
                        "load",
                    )
                })
            }
            SessionSelection::Open { session_id, .. }
                if capabilities.session_capabilities.resume.is_some() =>
            {
                let response = tokio::time::timeout(
                    SESSION_LIFECYCLE_TIMEOUT,
                    connection
                        .send_request(ResumeSessionRequest::new(
                            session_id.clone(),
                            cwd.to_path_buf(),
                        ))
                        .block_task(),
                )
                .await
                .context("agent session/resume timed out")?;
                response.map(|response| {
                    (
                        SessionId::new(session_id.clone()),
                        response.config_options,
                        response.modes,
                        "resume",
                    )
                })
            }
            SessionSelection::Open { .. } => {
                return Err(anyhow!(
                    "agent does not support session/load or session/resume"
                ));
            }
        };

        match result {
            Ok((session_id, config_options, modes, method)) => {
                emit(&json!({
                    "type": "session_started",
                    "session_id": session_id,
                    "method": method,
                    "config_options": config_options,
                    "modes": modes,
                }))
                .await?;
                return Ok(Some(ActiveSession { id: session_id }));
            }
            Err(error)
                if error.code == agent_client_protocol::schema::v1::ErrorCode::AuthRequired =>
            {
                emit(&json!({
                    "type": "auth_required",
                    "message": error.message,
                    "auth_methods": auth_methods,
                }))
                .await?;
            }
            Err(error) => return Err(anyhow!("agent rejected session/new: {error}")),
        }

        loop {
            match commands.recv().await {
                Some(HostCommand::Authenticate { method_id }) => {
                    let Some(method) = auth_methods
                        .iter()
                        .find(|method| method.id().to_string() == method_id)
                    else {
                        emit(&json!({
                            "type": "error",
                            "message": format!("unknown authentication method `{method_id}`")
                        }))
                        .await?;
                        continue;
                    };
                    match method {
                        AuthMethod::Agent(_) => {
                            tokio::time::timeout(
                                SESSION_LIFECYCLE_TIMEOUT,
                                connection
                                    .send_request(AuthenticateRequest::new(method_id))
                                    .block_task(),
                            )
                            .await
                            .context("agent authenticate timed out")?
                            .context("agent authentication failed")?;
                            emit(&json!({ "type": "authenticated" })).await?;
                            break;
                        }
                        AuthMethod::Terminal(terminal) => {
                            let mut env = launch.env.clone();
                            env.extend(terminal.env.clone());
                            let mut args = launch.args.clone();
                            args.extend(terminal.args.clone());
                            emit(&json!({
                                "type": "terminal_auth",
                                "command": launch.command,
                                "args": args,
                                "env": env,
                                "name": terminal.name,
                            }))
                            .await?;
                        }
                        AuthMethod::EnvVar(_) => {
                            emit(&json!({
                                "type": "error",
                                "message": "enter the requested environment credentials in VS Code"
                            }))
                            .await?;
                        }
                        _ => {
                            emit(&json!({
                                "type": "error",
                                "message": "unsupported authentication method"
                            }))
                            .await?;
                        }
                    }
                }
                Some(HostCommand::RetrySession) => break,
                Some(HostCommand::Disconnect) | None => return Ok(None),
                Some(_) => {
                    emit(&json!({
                        "type": "error",
                        "message": "authenticate before starting the ACP session"
                    }))
                    .await?;
                }
            }
        }
    }
}

async fn emit_connection_progress(connection_id: u64, stage: &str, message: &str) -> Result<()> {
    emit(&json!({
        "type": "connection_progress",
        "connection_id": connection_id,
        "stage": stage,
        "message": message,
    }))
    .await
}

async fn capture_agent_stderr(mut stderr: ChildStderr, tail: Arc<Mutex<Vec<u8>>>) {
    let mut buffer = [0_u8; 1024];
    loop {
        let read = match stderr.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => {
                eprintln!("could not read ACP agent stderr: {error}");
                break;
            }
        };
        let bytes = &buffer[..read];
        let _ = std::io::stderr().write_all(bytes);
        if let Ok(mut tail) = tail.lock() {
            tail.extend_from_slice(bytes);
            if tail.len() > MAX_AGENT_STDERR_BYTES {
                let excess = tail.len() - MAX_AGENT_STDERR_BYTES;
                tail.drain(..excess);
            }
        }
    }
}

fn agent_exit_error(status: ExitStatus, stderr_tail: &Arc<Mutex<Vec<u8>>>) -> anyhow::Error {
    let status = status
        .code()
        .map(|code| format!("exit code {code}"))
        .unwrap_or_else(|| "a signal".to_owned());
    let output = stderr_tail
        .lock()
        .ok()
        .map(|tail| String::from_utf8_lossy(&tail).trim().to_owned())
        .unwrap_or_default();
    if output.is_empty() {
        anyhow!("ACP agent exited unexpectedly with {status}")
    } else {
        anyhow!("ACP agent exited unexpectedly with {status}.\n\nAgent output:\n{output}")
    }
}

async fn refresh_sessions(
    connection: &ConnectionTo<Agent>,
    cwd: &Path,
    capabilities: &AgentCapabilities,
) -> Result<()> {
    if capabilities.session_capabilities.list.is_none() {
        emit(&json!({
            "type": "agent_sessions",
            "supported": false,
            "sessions": [],
        }))
        .await?;
        return Ok(());
    }

    let mut sessions = Vec::new();
    let mut cursor = None;
    loop {
        let response = connection
            .send_request(
                ListSessionsRequest::new()
                    .cwd(cwd.to_path_buf())
                    .cursor(cursor),
            )
            .block_task();
        let response = tokio::time::timeout(SESSION_LIST_TIMEOUT, response)
            .await
            .context("agent session/list timed out")?
            .context("agent rejected session/list")?;
        sessions.extend(response.sessions);
        cursor = response.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    emit(&json!({
        "type": "agent_sessions",
        "supported": true,
        "sessions": sessions,
    }))
    .await
}

async fn report_session_list(
    connection: &ConnectionTo<Agent>,
    cwd: &Path,
    capabilities: &AgentCapabilities,
) -> Result<()> {
    if let Err(error) = refresh_sessions(connection, cwd, capabilities).await {
        emit(&json!({
            "type": "session_list_error",
            "message": format!("{error:#}"),
        }))
        .await?;
    }
    Ok(())
}

async fn delete_session(
    connection: &ConnectionTo<Agent>,
    session_id: &str,
    capabilities: &AgentCapabilities,
) -> Result<()> {
    if capabilities.session_capabilities.delete.is_none() {
        return Err(anyhow!("agent does not support session/delete"));
    }
    tokio::time::timeout(
        SESSION_LIFECYCLE_TIMEOUT,
        connection
            .send_request(DeleteSessionRequest::new(session_id.to_owned()))
            .block_task(),
    )
    .await
    .context("agent session/delete timed out")?
    .context("agent rejected session/delete")?;
    emit(&json!({
        "type": "session_deleted",
        "session_id": session_id,
    }))
    .await
}

async fn emit_session_update(update: SessionUpdate) {
    let _ = emit(&json!({
        "type": "session_update",
        "update": update,
    }))
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Read as _;
    use std::net::TcpListener;
    use tokio::sync::mpsc::UnboundedReceiver;

    async fn next_event(events: &mut UnboundedReceiver<Value>, expected: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let event = events.recv().await.expect("event channel remains open");
                if event["type"] == expected {
                    return event;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for `{expected}`"))
    }

    fn fake_launch(mode: &str) -> LaunchSpec {
        LaunchSpec {
            command: PathBuf::from("python3"),
            args: vec![
                "-u".into(),
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/fake_agent.py")
                    .to_string_lossy()
                    .into_owned(),
                mode.into(),
            ],
            env: HashMap::new(),
        }
    }

    fn serve_registry(body: Vec<u8>, requests: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind registry server");
        let address = listener.local_addr().expect("registry server address");
        std::thread::spawn(move || {
            for _ in 0..requests {
                let (mut stream, _) = listener.accept().expect("accept registry request");
                let mut request = [0_u8; 4096];
                let _ = stream.read(&mut request).expect("read registry request");
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .expect("write registry response headers");
                stream.write_all(&body).expect("write registry response");
            }
        });
        format!("http://{address}/registry.json")
    }

    #[test]
    fn parses_connect_command_with_defaults() {
        let command: HostCommand = serde_json::from_value(json!({
            "type": "connect",
            "command": "anvil",
            "cwd": "/workspace"
        }))
        .expect("connect command should deserialize");

        match command {
            HostCommand::Connect {
                command,
                args,
                cwd,
                env,
                session,
            } => {
                assert_eq!(command, PathBuf::from("anvil"));
                assert!(args.is_empty());
                assert_eq!(cwd, PathBuf::from("/workspace"));
                assert!(env.is_empty());
                assert!(matches!(session, SessionSelection::Browse));
            }
            other => panic!("expected connect command, got {other:?}"),
        }
    }

    #[test]
    fn parses_catalog_and_install_commands() {
        assert!(matches!(
            serde_json::from_value::<HostCommand>(json!({
                "type": "list_agents",
                "storage_dir": "/cache"
            })),
            Ok(HostCommand::ListAgents { registry_url, .. })
                if registry_url == DEFAULT_REGISTRY_URL
        ));
        assert!(matches!(
            serde_json::from_value::<HostCommand>(json!({
                "type": "install_agent",
                "agent_id": "codex-acp",
                "storage_dir": "/cache"
            })),
            Ok(HostCommand::InstallAgent { agent_id, .. }) if agent_id == "codex-acp"
        ));
    }

    #[test]
    fn parses_prompt_and_control_commands() {
        assert!(matches!(
            serde_json::from_value::<HostCommand>(json!({
                "type": "prompt",
                "text": "hello"
            })),
            Ok(HostCommand::Prompt { text }) if text == "hello"
        ));
        assert!(matches!(
            serde_json::from_value::<HostCommand>(json!({ "type": "cancel" })),
            Ok(HostCommand::Cancel)
        ));
        assert!(matches!(
            serde_json::from_value::<HostCommand>(json!({ "type": "disconnect" })),
            Ok(HostCommand::Disconnect)
        ));
    }

    #[test]
    fn parses_session_lifecycle_commands() {
        assert!(matches!(
            serde_json::from_value::<HostCommand>(json!({
                "type": "connect",
                "command": "anvil",
                "cwd": "/workspace",
                "session": { "mode": "new" }
            })),
            Ok(HostCommand::Connect {
                session: SessionSelection::New,
                ..
            })
        ));
        assert!(matches!(
            serde_json::from_value::<HostCommand>(json!({
                "type": "open_session",
                "session_id": "session-1"
            })),
            Ok(HostCommand::OpenSession {
                session_id,
                replay: true,
            }) if session_id == "session-1"
        ));
        assert!(matches!(
            serde_json::from_value::<HostCommand>(json!({
                "type": "delete_session",
                "session_id": "session-1"
            })),
            Ok(HostCommand::DeleteSession { session_id }) if session_id == "session-1"
        ));
    }

    #[test]
    fn rejects_unknown_command_types() {
        assert!(
            serde_json::from_value::<HostCommand>(json!({ "type": "launch_missiles" })).is_err()
        );
    }

    #[test]
    fn permission_option_ids_serialize_as_strings() {
        assert_eq!(
            serde_json::to_value(agent_client_protocol::schema::v1::PermissionOptionId::new(
                "allow_once"
            ),)
            .expect("serialize"),
            json!("allow_once")
        );
    }

    #[tokio::test]
    async fn runtime_drives_complete_agent_session_lifecycle() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (event_tx, mut events) = mpsc::unbounded_channel();
        EVENTS
            .set(event_tx)
            .expect("runtime event channel initialized once");
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let runtime = tokio::spawn(run(command_rx));

        let registry_storage = tempfile::tempdir().expect("registry storage");
        let registry_url = serve_registry(
            serde_json::to_vec(&json!({
                "version": "test",
                "agents": [{
                    "id": "package-agent",
                    "name": "Package Agent",
                    "version": "1.0.0",
                    "description": "Coverage fixture",
                    "distribution": {
                        "npx": {"package": "package-agent@1.0.0"}
                    }
                }]
            }))
            .expect("registry JSON"),
            2,
        );
        command_tx
            .send(HostCommand::ListAgents {
                storage_dir: registry_storage.path().to_owned(),
                registry_url: registry_url.clone(),
            })
            .expect("list agents");
        next_event(&mut events, "catalog_loading").await;
        assert_eq!(next_event(&mut events, "catalog").await["cached"], false);
        command_tx
            .send(HostCommand::InstallAgent {
                agent_id: "package-agent".into(),
                storage_dir: registry_storage.path().to_owned(),
                registry_url,
            })
            .expect("install package agent");
        next_event(&mut events, "installing_agent").await;
        next_event(&mut events, "agent_installed").await;
        next_event(&mut events, "catalog").await;

        let empty_storage = tempfile::tempdir().expect("empty registry storage");
        command_tx
            .send(HostCommand::ListAgents {
                storage_dir: empty_storage.path().to_owned(),
                registry_url: "http://127.0.0.1:1/unavailable".into(),
            })
            .expect("list unavailable registry");
        next_event(&mut events, "catalog_loading").await;
        assert!(
            next_event(&mut events, "error").await["message"]
                .as_str()
                .expect("registry error")
                .contains("no cached registry")
        );

        command_tx
            .send(HostCommand::Prompt {
                text: "before connect".into(),
            })
            .expect("send command");
        assert_eq!(
            next_event(&mut events, "error").await["message"],
            "connect to an ACP agent before sending session commands"
        );

        let launch = fake_launch("normal");
        command_tx
            .send(HostCommand::Connect {
                command: launch.command,
                args: launch.args,
                cwd: workspace.path().to_owned(),
                env: launch.env,
                session: SessionSelection::Browse,
            })
            .expect("connect");
        next_event(&mut events, "connecting").await;
        next_event(&mut events, "connection_progress").await;
        next_event(&mut events, "connected").await;
        next_event(&mut events, "connection_progress").await;
        assert_eq!(
            next_event(&mut events, "agent_sessions").await["supported"],
            true
        );

        command_tx
            .send(HostCommand::RefreshSessions)
            .expect("refresh sessions");
        next_event(&mut events, "agent_sessions").await;
        command_tx
            .send(HostCommand::NewSession)
            .expect("new session");
        assert_eq!(
            next_event(&mut events, "session_started").await["method"],
            "new"
        );

        command_tx
            .send(HostCommand::SetConfig {
                config_id: "mode".into(),
                value: json!({"value": "plan"}),
            })
            .expect("set config");
        next_event(&mut events, "config_options").await;
        command_tx
            .send(HostCommand::Prompt {
                text: "build it".into(),
            })
            .expect("prompt");
        next_event(&mut events, "turn_started").await;
        next_event(&mut events, "session_update").await;
        assert_eq!(
            next_event(&mut events, "turn_completed").await["stop_reason"],
            "end_turn"
        );

        command_tx
            .send(HostCommand::DeleteSession {
                session_id: "session-new".into(),
            })
            .expect("delete active session");
        assert!(
            next_event(&mut events, "error").await["message"]
                .as_str()
                .expect("error message")
                .contains("active session")
        );
        command_tx
            .send(HostCommand::OpenSession {
                session_id: "saved-session".into(),
                replay: true,
            })
            .expect("load session");
        next_event(&mut events, "session_replay_started").await;
        assert_eq!(
            next_event(&mut events, "session_started").await["method"],
            "load"
        );
        command_tx
            .send(HostCommand::DeleteSession {
                session_id: "session-new".into(),
            })
            .expect("delete inactive session");
        next_event(&mut events, "session_deleted").await;
        next_event(&mut events, "agent_sessions").await;
        command_tx
            .send(HostCommand::Disconnect)
            .expect("disconnect");
        assert_eq!(
            next_event(&mut events, "disconnected").await["reason"],
            "requested"
        );

        let launch = fake_launch("resume");
        command_tx
            .send(HostCommand::Connect {
                command: launch.command,
                args: launch.args,
                cwd: workspace.path().to_owned(),
                env: launch.env,
                session: SessionSelection::Open {
                    session_id: "saved-session".into(),
                    replay: false,
                },
            })
            .expect("connect resume agent");
        next_event(&mut events, "connecting").await;
        next_event(&mut events, "connection_progress").await;
        next_event(&mut events, "connected").await;
        assert_eq!(
            next_event(&mut events, "session_started").await["method"],
            "resume"
        );
        command_tx
            .send(HostCommand::Disconnect)
            .expect("disconnect resume agent");
        next_event(&mut events, "disconnected").await;

        let launch = fake_launch("reject");
        command_tx
            .send(HostCommand::Connect {
                command: launch.command,
                args: launch.args,
                cwd: workspace.path().to_owned(),
                env: launch.env,
                session: SessionSelection::New,
            })
            .expect("connect rejecting agent");
        next_event(&mut events, "connecting").await;
        next_event(&mut events, "connection_progress").await;
        next_event(&mut events, "connected").await;
        assert!(
            next_event(&mut events, "error").await["message"]
                .as_str()
                .expect("connection error")
                .contains("new session rejected")
        );
        next_event(&mut events, "disconnected").await;

        let launch = fake_launch("clientio");
        command_tx
            .send(HostCommand::Connect {
                command: launch.command,
                args: launch.args,
                cwd: workspace.path().to_owned(),
                env: launch.env,
                session: SessionSelection::New,
            })
            .expect("connect client IO agent");
        next_event(&mut events, "connecting").await;
        next_event(&mut events, "connection_progress").await;
        next_event(&mut events, "connected").await;
        next_event(&mut events, "session_started").await;
        assert_eq!(
            fs::read_to_string(workspace.path().join("agent-created.txt"))
                .expect("agent-written file"),
            "written by fake agent"
        );

        command_tx
            .send(HostCommand::Prompt {
                text: "request permission".into(),
            })
            .expect("permission prompt");
        next_event(&mut events, "turn_started").await;
        let permission = next_event(&mut events, "permission_request").await;
        command_tx
            .send(HostCommand::RefreshSessions)
            .expect("command during prompt");
        assert_eq!(
            next_event(&mut events, "error").await["message"],
            "a prompt is already running"
        );
        command_tx
            .send(HostCommand::PermissionResponse {
                request_id: permission["request_id"]
                    .as_str()
                    .expect("permission request id")
                    .into(),
                option_id: Some("not-offered".into()),
            })
            .expect("reject invalid permission option");
        assert_eq!(
            next_event(&mut events, "error").await["message"],
            "permission request is no longer active"
        );
        next_event(&mut events, "turn_completed").await;

        command_tx
            .send(HostCommand::Prompt {
                text: "approve permission".into(),
            })
            .expect("approved permission prompt");
        next_event(&mut events, "turn_started").await;
        let permission = next_event(&mut events, "permission_request").await;
        command_tx
            .send(HostCommand::PermissionResponse {
                request_id: permission["request_id"]
                    .as_str()
                    .expect("permission request id")
                    .into(),
                option_id: Some("allow_once".into()),
            })
            .expect("approve permission");
        next_event(&mut events, "turn_completed").await;

        command_tx
            .send(HostCommand::Prompt {
                text: "cancel then finish".into(),
            })
            .expect("cancelled permission prompt");
        next_event(&mut events, "turn_started").await;
        let permission = next_event(&mut events, "permission_request").await;
        command_tx.send(HostCommand::Cancel).expect("cancel prompt");
        command_tx
            .send(HostCommand::PermissionResponse {
                request_id: permission["request_id"]
                    .as_str()
                    .expect("permission request id")
                    .into(),
                option_id: Some("allow_once".into()),
            })
            .expect("finish cancelled prompt");
        next_event(&mut events, "turn_completed").await;

        command_tx
            .send(HostCommand::PermissionResponse {
                request_id: "expired".into(),
                option_id: None,
            })
            .expect("expired permission");
        next_event(&mut events, "error").await;
        command_tx.send(HostCommand::Cancel).expect("idle cancel");
        command_tx
            .send(HostCommand::Authenticate {
                method_id: "unused".into(),
            })
            .expect("unexpected connected command");
        assert_eq!(
            next_event(&mut events, "error").await["message"],
            "already connected"
        );
        command_tx
            .send(HostCommand::Disconnect)
            .expect("disconnect client IO agent");
        next_event(&mut events, "disconnected").await;

        let launch = fake_launch("unsupported");
        command_tx
            .send(HostCommand::Connect {
                command: launch.command,
                args: launch.args,
                cwd: workspace.path().to_owned(),
                env: launch.env,
                session: SessionSelection::Browse,
            })
            .expect("connect limited agent");
        next_event(&mut events, "connecting").await;
        next_event(&mut events, "connection_progress").await;
        next_event(&mut events, "connected").await;
        next_event(&mut events, "connection_progress").await;
        assert_eq!(
            next_event(&mut events, "agent_sessions").await["supported"],
            false
        );
        command_tx
            .send(HostCommand::Prompt {
                text: "without a session".into(),
            })
            .expect("prompt without session");
        next_event(&mut events, "error").await;
        command_tx
            .send(HostCommand::SetConfig {
                config_id: "mode".into(),
                value: json!({"value": "plan"}),
            })
            .expect("config without session");
        next_event(&mut events, "error").await;
        command_tx
            .send(HostCommand::DeleteSession {
                session_id: "saved-session".into(),
            })
            .expect("unsupported delete");
        assert!(
            next_event(&mut events, "error").await["message"]
                .as_str()
                .expect("delete error")
                .contains("does not support session/delete")
        );
        next_event(&mut events, "disconnected").await;

        let launch = fake_launch("unsupported");
        command_tx
            .send(HostCommand::Connect {
                command: launch.command,
                args: launch.args,
                cwd: workspace.path().to_owned(),
                env: launch.env,
                session: SessionSelection::Open {
                    session_id: "saved-session".into(),
                    replay: false,
                },
            })
            .expect("open unsupported session");
        next_event(&mut events, "connecting").await;
        next_event(&mut events, "connection_progress").await;
        next_event(&mut events, "connected").await;
        assert!(
            next_event(&mut events, "error").await["message"]
                .as_str()
                .expect("unsupported session error")
                .contains("does not support session/load or session/resume")
        );
        next_event(&mut events, "disconnected").await;

        let launch = fake_launch("exit");
        command_tx
            .send(HostCommand::Connect {
                command: launch.command,
                args: launch.args,
                cwd: workspace.path().to_owned(),
                env: launch.env,
                session: SessionSelection::Browse,
            })
            .expect("connect exiting agent");
        next_event(&mut events, "connecting").await;
        assert!(
            next_event(&mut events, "error").await["message"]
                .as_str()
                .expect("agent exit error")
                .contains("fake agent exited before initialization")
        );
        next_event(&mut events, "disconnected").await;

        drop(command_tx);
        runtime.await.expect("runtime task").expect("runtime exits");
    }
}
