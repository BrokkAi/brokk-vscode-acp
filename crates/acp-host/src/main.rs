mod client_io;
mod registry;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;

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
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

static EVENTS: OnceLock<mpsc::UnboundedSender<Value>> = OnceLock::new();

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

async fn run(mut commands: mpsc::UnboundedReceiver<HostCommand>) -> Result<()> {
    while let Some(command) = commands.recv().await {
        match command {
            HostCommand::ListAgents {
                storage_dir,
                registry_url,
            } => {
                if let Err(error) = list_agents(&registry_url, &storage_dir).await {
                    emit_error(error).await?;
                }
            }
            HostCommand::InstallAgent {
                agent_id,
                storage_dir,
                registry_url,
            } => {
                if let Err(error) = install_agent(&registry_url, &storage_dir, &agent_id).await {
                    emit_error(error).await?;
                }
            }
            HostCommand::Connect {
                command,
                args,
                cwd,
                env,
                session,
            } => {
                let launch = LaunchSpec { command, args, env };
                emit(&json!({
                    "type": "connecting",
                    "command": launch.command,
                }))
                .await?;
                if let Err(error) = run_connection(launch, cwd, session, &mut commands).await {
                    emit_error(error).await?;
                }
                emit(&json!({ "type": "disconnected" })).await?;
            }
            _ => {
                emit(&json!({
                    "type": "error",
                    "message": "connect to an ACP agent before sending session commands"
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
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("could not start ACP agent `{}`", launch.command.display()))?;
    let child_stdin = child.stdin.take().context("agent stdin was not piped")?;
    let child_stdout = child.stdout.take().context("agent stdout was not piped")?;
    let transport = ByteStreams::new(child_stdin.compat_write(), child_stdout.compat());

    let result = drive_client(
        transport,
        cwd,
        launch,
        session,
        commands,
        workspace.clone(),
        permissions.clone(),
    )
    .await;
    permissions.cancel_all().await;
    workspace.shutdown().await;
    let _ = child.kill().await;
    result
}

async fn drive_client<T>(
    transport: T,
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
            drive_session(connection, cwd, launch, session, commands, permissions)
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
        .block_task()
        .await
        .context("agent rejected initialize")?;
    let auth_methods = response.auth_methods.clone();
    let agent_capabilities = response.agent_capabilities.clone();

    emit(&json!({
        "type": "connected",
        "agent": response.agent_info.map(|info| info.name),
        "protocol_version": response.protocol_version,
        "agent_capabilities": agent_capabilities,
        "auth_methods": auth_methods,
    }))
    .await?;

    refresh_sessions(&connection, &cwd, &agent_capabilities).await?;

    let mut active_session = match initial_session {
        SessionSelection::Browse => None,
        selection => {
            start_session(
                &connection,
                &cwd,
                &launch,
                &auth_methods,
                &agent_capabilities,
                selection,
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
                    commands,
                )
                .await?;
                refresh_sessions(&connection, &cwd, &agent_capabilities).await?;
            }
            HostCommand::OpenSession { session_id, replay } => {
                active_session = start_session(
                    &connection,
                    &cwd,
                    &launch,
                    &auth_methods,
                    &agent_capabilities,
                    SessionSelection::Open { session_id, replay },
                    commands,
                )
                .await?;
            }
            HostCommand::RefreshSessions => {
                refresh_sessions(&connection, &cwd, &agent_capabilities).await?;
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
                refresh_sessions(&connection, &cwd, &agent_capabilities).await?;
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
                let response = connection
                    .send_request(SetSessionConfigOptionRequest::new(
                        session.id.clone(),
                        config_id,
                        value,
                    ))
                    .block_task()
                    .await
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
    commands: &mut mpsc::UnboundedReceiver<HostCommand>,
) -> Result<Option<ActiveSession>> {
    let (requested_id, replay) = match &selection {
        SessionSelection::Browse => return Ok(None),
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
            SessionSelection::New => connection
                .send_request(NewSessionRequest::new(cwd.to_path_buf()))
                .block_task()
                .await
                .map(|response| {
                    (
                        response.session_id,
                        response.config_options,
                        response.modes,
                        "new",
                    )
                }),
            SessionSelection::Open {
                session_id,
                replay: true,
            } if capabilities.load_session => connection
                .send_request(LoadSessionRequest::new(
                    session_id.clone(),
                    cwd.to_path_buf(),
                ))
                .block_task()
                .await
                .map(|response| {
                    (
                        SessionId::new(session_id.clone()),
                        response.config_options,
                        response.modes,
                        "load",
                    )
                }),
            SessionSelection::Open { session_id, .. }
                if capabilities.session_capabilities.resume.is_some() =>
            {
                connection
                    .send_request(ResumeSessionRequest::new(
                        session_id.clone(),
                        cwd.to_path_buf(),
                    ))
                    .block_task()
                    .await
                    .map(|response| {
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
                            connection
                                .send_request(AuthenticateRequest::new(method_id))
                                .block_task()
                                .await
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
            .block_task()
            .await
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

async fn delete_session(
    connection: &ConnectionTo<Agent>,
    session_id: &str,
    capabilities: &AgentCapabilities,
) -> Result<()> {
    if capabilities.session_capabilities.delete.is_none() {
        return Err(anyhow!("agent does not support session/delete"));
    }
    connection
        .send_request(DeleteSessionRequest::new(session_id.to_owned()))
        .block_task()
        .await
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
}
