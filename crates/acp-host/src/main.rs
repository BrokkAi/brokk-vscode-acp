use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ClientCapabilities, ContentBlock, ContentChunk, Implementation,
    InitializeRequest, NewSessionRequest, PromptRequest, SessionNotification, SessionUpdate,
    TextContent,
};
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectTo, ConnectionTo};
use anyhow::{Context, Result, anyhow};
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
    Connect {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        cwd: PathBuf,
        #[serde(default)]
        env: HashMap<String, String>,
    },
    Prompt {
        text: String,
    },
    Cancel,
    Disconnect,
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
        let HostCommand::Connect {
            command,
            args,
            cwd,
            env,
        } = command
        else {
            continue;
        };
        emit(&json!({ "type": "connecting", "command": command })).await?;
        let result = run_connection(command, args, cwd, env, &mut commands).await;
        if let Err(error) = result {
            emit(&json!({
                "type": "error",
                "message": format!("{error:#}")
            }))
            .await?;
        }
        emit(&json!({ "type": "disconnected" })).await?;
    }
    Ok(())
}

async fn run_connection(
    command: String,
    args: Vec<String>,
    cwd: PathBuf,
    env: HashMap<String, String>,
    commands: &mut mpsc::UnboundedReceiver<HostCommand>,
) -> Result<()> {
    let mut child = Command::new(&command)
        .args(&args)
        .current_dir(&cwd)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("could not start ACP agent `{command}`"))?;
    let child_stdin = child.stdin.take().context("agent stdin was not piped")?;
    let child_stdout = child.stdout.take().context("agent stdout was not piped")?;
    let transport = ByteStreams::new(child_stdin.compat_write(), child_stdout.compat());

    let result = drive_client(transport, cwd, commands).await;
    let _ = child.kill().await;
    result
}

async fn drive_client<T>(
    transport: T,
    cwd: PathBuf,
    commands: &mut mpsc::UnboundedReceiver<HostCommand>,
) -> Result<()>
where
    T: ConnectTo<Client>,
{
    Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                emit_session_update(notification.update).await;
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .connect_with(transport, |connection: ConnectionTo<Agent>| async move {
            drive_session(connection, cwd, commands)
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
    commands: &mut mpsc::UnboundedReceiver<HostCommand>,
) -> Result<()> {
    let response = connection
        .send_request(
            InitializeRequest::new(ProtocolVersion::V1)
                .client_info(Implementation::new(
                    "brokk-vscode-acp",
                    env!("CARGO_PKG_VERSION"),
                ))
                .client_capabilities(ClientCapabilities::new()),
        )
        .block_task()
        .await
        .context("agent rejected initialize")?;

    emit(&json!({
        "type": "connected",
        "agent": response.agent_info.map(|info| info.name),
        "protocol_version": response.protocol_version,
    }))
    .await?;

    let session = connection
        .send_request(NewSessionRequest::new(cwd))
        .block_task()
        .await
        .context("agent rejected session/new")?;
    let session_id = session.session_id;
    emit(&json!({
        "type": "session_started",
        "session_id": session_id,
        "config_options": session.config_options,
    }))
    .await?;

    while let Some(command) = commands.recv().await {
        match command {
            HostCommand::Prompt { text } => {
                emit(&json!({ "type": "turn_started" })).await?;
                let prompt = vec![ContentBlock::Text(TextContent::new(text))];
                let request = PromptRequest::new(session_id.clone(), prompt);
                let mut task = Box::pin(connection.send_request(request).block_task());
                loop {
                    tokio::select! {
                        result = &mut task => {
                            match result {
                                Ok(response) => emit(&json!({
                                    "type": "turn_completed",
                                    "stop_reason": response.stop_reason,
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
                                connection
                                    .send_notification(CancelNotification::new(session_id.clone()))
                                    .context("could not cancel prompt")?;
                            }
                            Some(HostCommand::Disconnect) | None => return Ok(()),
                            Some(HostCommand::Prompt { .. } | HostCommand::Connect { .. }) => {
                                emit(&json!({
                                    "type": "error",
                                    "message": "a prompt is already running"
                                })).await?;
                            }
                        }
                    }
                }
            }
            HostCommand::Cancel => {}
            HostCommand::Disconnect => break,
            HostCommand::Connect { .. } => {
                emit(&json!({ "type": "error", "message": "already connected" })).await?;
            }
        }
    }
    Ok(())
}

async fn emit_session_update(update: SessionUpdate) {
    let event = match update {
        SessionUpdate::AgentMessageChunk(ContentChunk { content, .. }) => match content {
            ContentBlock::Text(text) => json!({ "type": "message_chunk", "text": text.text }),
            other => json!({ "type": "session_update", "update": other }),
        },
        SessionUpdate::AgentThoughtChunk(ContentChunk { content, .. }) => match content {
            ContentBlock::Text(text) => json!({ "type": "thought_chunk", "text": text.text }),
            other => json!({ "type": "session_update", "update": other }),
        },
        other => json!({ "type": "session_update", "update": other }),
    };
    let _ = emit(&event).await;
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
            } => {
                assert_eq!(command, "anvil");
                assert!(args.is_empty());
                assert_eq!(cwd, PathBuf::from("/workspace"));
                assert!(env.is_empty());
            }
            other => panic!("expected connect command, got {other:?}"),
        }
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
    fn rejects_unknown_command_types() {
        assert!(
            serde_json::from_value::<HostCommand>(json!({ "type": "launch_missiles" })).is_err()
        );
    }
}
