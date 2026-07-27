use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CreateTerminalRequest, CreateTerminalResponse, KillTerminalRequest, KillTerminalResponse,
    ReadTextFileRequest, ReadTextFileResponse, ReleaseTerminalRequest, ReleaseTerminalResponse,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, TerminalExitStatus, TerminalOutputRequest, TerminalOutputResponse,
    WaitForTerminalExitRequest, WaitForTerminalExitResponse, WriteTextFileRequest,
    WriteTextFileResponse,
};
use anyhow::{Context, Result, bail};
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify, oneshot};
use uuid::Uuid;

use crate::emit;

#[derive(Clone, Default)]
pub struct PermissionBroker {
    pending: Arc<Mutex<HashMap<String, PendingPermission>>>,
}

struct PendingPermission {
    allowed_options: HashSet<String>,
    sender: oneshot::Sender<Option<String>>,
}

impl PermissionBroker {
    pub async fn request(&self, request: RequestPermissionRequest) -> RequestPermissionResponse {
        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        let allowed_options = request
            .options
            .iter()
            .map(|option| option.option_id.to_string())
            .collect();
        self.pending.lock().await.insert(
            request_id.clone(),
            PendingPermission {
                allowed_options,
                sender,
            },
        );
        if emit(&json!({
            "type": "permission_request",
            "request_id": request_id,
            "tool_call": request.tool_call,
            "options": request.options,
        }))
        .await
        .is_err()
        {
            self.pending.lock().await.remove(&request_id);
            return RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        }

        match receiver.await.ok().flatten() {
            Some(option_id) => RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(option_id),
            )),
            None => RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled),
        }
    }

    pub async fn resolve(&self, request_id: &str, option_id: Option<String>) -> bool {
        let Some(pending) = self.pending.lock().await.remove(request_id) else {
            return false;
        };
        if option_id
            .as_ref()
            .is_some_and(|option| !pending.allowed_options.contains(option))
        {
            let _ = pending.sender.send(None);
            return false;
        }
        pending.sender.send(option_id).is_ok()
    }

    pub async fn cancel_all(&self) {
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for pending in pending.into_values() {
            let _ = pending.sender.send(None);
        }
    }
}

#[derive(Clone)]
pub struct WorkspaceIo {
    root: Arc<PathBuf>,
    terminals: TerminalManager,
}

impl WorkspaceIo {
    pub fn new(root: &Path) -> Result<Self> {
        let root = root
            .canonicalize()
            .with_context(|| format!("resolving workspace root {}", root.display()))?;
        Ok(Self {
            root: Arc::new(root),
            terminals: TerminalManager::default(),
        })
    }

    pub async fn read_text_file(
        &self,
        request: ReadTextFileRequest,
    ) -> Result<ReadTextFileResponse> {
        let path = self.existing_path(&request.path)?;
        let content = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("reading {}", path.display()))?;
        if request.line.is_none() && request.limit.is_none() {
            return Ok(ReadTextFileResponse::new(content));
        }

        let first_line = request.line.unwrap_or(1);
        if first_line == 0 {
            bail!("line numbers are 1-based");
        }
        let limit = request.limit.unwrap_or(u32::MAX) as usize;
        let selected = content
            .split_inclusive('\n')
            .skip((first_line - 1) as usize)
            .take(limit)
            .collect::<String>();
        Ok(ReadTextFileResponse::new(selected))
    }

    pub async fn write_text_file(
        &self,
        request: WriteTextFileRequest,
    ) -> Result<WriteTextFileResponse> {
        let path = self.writable_path(&request.path)?;
        tokio::fs::write(&path, request.content)
            .await
            .with_context(|| format!("writing {}", path.display()))?;
        Ok(WriteTextFileResponse::new())
    }

    pub async fn create_terminal(
        &self,
        request: CreateTerminalRequest,
    ) -> Result<CreateTerminalResponse> {
        let cwd = match request.cwd {
            Some(ref path) => self.existing_path(path)?,
            None => self.root.as_ref().clone(),
        };
        self.terminals.create(request, cwd).await
    }

    pub async fn terminal_output(
        &self,
        request: TerminalOutputRequest,
    ) -> Result<TerminalOutputResponse> {
        self.terminals
            .output(&request.terminal_id.to_string())
            .await
    }

    pub async fn release_terminal(
        &self,
        request: ReleaseTerminalRequest,
    ) -> Result<ReleaseTerminalResponse> {
        self.terminals
            .release(&request.terminal_id.to_string())
            .await?;
        Ok(ReleaseTerminalResponse::new())
    }

    pub async fn kill_terminal(
        &self,
        request: KillTerminalRequest,
    ) -> Result<KillTerminalResponse> {
        self.terminals
            .kill(&request.terminal_id.to_string())
            .await?;
        Ok(KillTerminalResponse::new())
    }

    pub async fn wait_for_terminal(
        &self,
        request: WaitForTerminalExitRequest,
    ) -> Result<WaitForTerminalExitResponse> {
        let status = self
            .terminals
            .wait(&request.terminal_id.to_string())
            .await?;
        Ok(WaitForTerminalExitResponse::new(status))
    }

    pub async fn shutdown(&self) {
        self.terminals.shutdown().await;
    }

    fn existing_path(&self, requested: &Path) -> Result<PathBuf> {
        if !requested.is_absolute() {
            bail!("ACP filesystem paths must be absolute");
        }
        let canonical = requested
            .canonicalize()
            .with_context(|| format!("resolving {}", requested.display()))?;
        if !canonical.starts_with(self.root.as_ref()) {
            bail!(
                "path {} is outside workspace {}",
                requested.display(),
                self.root.display()
            );
        }
        Ok(canonical)
    }

    fn writable_path(&self, requested: &Path) -> Result<PathBuf> {
        if !requested.is_absolute()
            || requested.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::CurDir | Component::Prefix(_)
                )
            })
        {
            bail!("ACP write path must be an absolute path without traversal components");
        }
        let mut ancestor = requested;
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .context("write path has no existing ancestor")?;
        }
        let canonical = ancestor
            .canonicalize()
            .with_context(|| format!("resolving {}", ancestor.display()))?;
        if !canonical.starts_with(self.root.as_ref()) {
            bail!(
                "path {} is outside workspace {}",
                requested.display(),
                self.root.display()
            );
        }
        Ok(requested.to_owned())
    }
}

#[derive(Clone, Default)]
struct TerminalManager {
    entries: Arc<Mutex<HashMap<String, Arc<TerminalEntry>>>>,
}

struct TerminalEntry {
    child: Mutex<Option<Child>>,
    output: Mutex<Vec<u8>>,
    output_limit: usize,
    truncated: Mutex<bool>,
    exit_status: Mutex<Option<TerminalExitStatus>>,
    exited: Notify,
    streams_remaining: AtomicUsize,
    streams_drained: Notify,
}

impl TerminalManager {
    async fn create(
        &self,
        request: CreateTerminalRequest,
        cwd: PathBuf,
    ) -> Result<CreateTerminalResponse> {
        let mut command = Command::new(&request.command);
        command
            .args(&request.args)
            .envs(request.env.iter().map(|item| (&item.name, &item.value)))
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .with_context(|| format!("starting terminal command `{}`", request.command))?;
        let stdout = child
            .stdout
            .take()
            .context("terminal stdout was not piped")?;
        let stderr = child
            .stderr
            .take()
            .context("terminal stderr was not piped")?;
        let terminal_id = Uuid::new_v4().to_string();
        let entry = Arc::new(TerminalEntry {
            child: Mutex::new(Some(child)),
            output: Mutex::new(Vec::new()),
            output_limit: request
                .output_byte_limit
                .unwrap_or(1024 * 1024)
                .min(64 * 1024 * 1024) as usize,
            truncated: Mutex::new(false),
            exit_status: Mutex::new(None),
            exited: Notify::new(),
            streams_remaining: AtomicUsize::new(2),
            streams_drained: Notify::new(),
        });
        self.entries
            .lock()
            .await
            .insert(terminal_id.clone(), entry.clone());
        capture_output(stdout, entry.clone());
        capture_output(stderr, entry.clone());
        poll_exit(entry);
        Ok(CreateTerminalResponse::new(terminal_id))
    }

    async fn output(&self, terminal_id: &str) -> Result<TerminalOutputResponse> {
        let entry = self.entry(terminal_id).await?;
        let output = String::from_utf8_lossy(&entry.output.lock().await).into_owned();
        let truncated = *entry.truncated.lock().await;
        let status = entry.exit_status.lock().await.clone();
        Ok(TerminalOutputResponse::new(output, truncated).exit_status(status))
    }

    async fn wait(&self, terminal_id: &str) -> Result<TerminalExitStatus> {
        let entry = self.entry(terminal_id).await?;
        loop {
            if let Some(status) = entry.exit_status.lock().await.clone() {
                return Ok(status);
            }
            entry.exited.notified().await;
        }
    }

    async fn kill(&self, terminal_id: &str) -> Result<()> {
        let entry = self.entry(terminal_id).await?;
        let mut child = entry.child.lock().await;
        if let Some(child) = child.as_mut() {
            child
                .kill()
                .await
                .with_context(|| format!("killing terminal {terminal_id}"))?;
        }
        Ok(())
    }

    async fn release(&self, terminal_id: &str) -> Result<()> {
        let entry = self
            .entries
            .lock()
            .await
            .remove(terminal_id)
            .with_context(|| format!("unknown terminal `{terminal_id}`"))?;
        if let Some(child) = entry.child.lock().await.as_mut() {
            let _ = child.kill().await;
        }
        Ok(())
    }

    async fn shutdown(&self) {
        let entries = std::mem::take(&mut *self.entries.lock().await);
        for entry in entries.into_values() {
            if let Some(child) = entry.child.lock().await.as_mut() {
                let _ = child.kill().await;
            }
        }
    }

    async fn entry(&self, terminal_id: &str) -> Result<Arc<TerminalEntry>> {
        self.entries
            .lock()
            .await
            .get(terminal_id)
            .cloned()
            .with_context(|| format!("unknown terminal `{terminal_id}`"))
    }
}

fn capture_output(
    mut reader: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    entry: Arc<TerminalEntry>,
) {
    tokio::spawn(async move {
        let mut chunk = [0_u8; 8192];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(length) => {
                    let mut output = entry.output.lock().await;
                    output.extend_from_slice(&chunk[..length]);
                    if output.len() > entry.output_limit {
                        let remove = output.len() - entry.output_limit;
                        output.drain(..remove);
                        *entry.truncated.lock().await = true;
                    }
                }
            }
        }
        if entry.streams_remaining.fetch_sub(1, Ordering::AcqRel) == 1 {
            entry.streams_drained.notify_waiters();
        }
    });
}

fn poll_exit(entry: Arc<TerminalEntry>) {
    tokio::spawn(async move {
        loop {
            let result = {
                let mut child = entry.child.lock().await;
                match child.as_mut() {
                    Some(child) => child.try_wait(),
                    None => return,
                }
            };
            match result {
                Ok(Some(status)) => {
                    while entry.streams_remaining.load(Ordering::Acquire) != 0 {
                        entry.streams_drained.notified().await;
                    }
                    let mut exit = TerminalExitStatus::new();
                    if let Some(code) = status.code() {
                        exit = exit.exit_code(code.max(0) as u32);
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::process::ExitStatusExt;
                        if let Some(signal) = status.signal() {
                            exit = exit.signal(signal.to_string());
                        }
                    }
                    *entry.exit_status.lock().await = Some(exit);
                    *entry.child.lock().await = None;
                    entry.exited.notify_waiters();
                    return;
                }
                Ok(None) => tokio::time::sleep(Duration::from_millis(50)).await,
                Err(_) => {
                    *entry.exit_status.lock().await = Some(TerminalExitStatus::new());
                    *entry.child.lock().await = None;
                    entry.exited.notify_waiters();
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn workspace_io_rejects_paths_outside_root() {
        let root = tempfile::tempdir().expect("workspace");
        let outside = tempfile::tempdir().expect("outside");
        let workspace = WorkspaceIo::new(root.path()).expect("workspace IO");
        let error = workspace
            .read_text_file(ReadTextFileRequest::new("session", outside.path()))
            .await
            .expect_err("outside path should fail");
        assert!(error.to_string().contains("outside workspace"));
    }

    #[test]
    fn writable_path_rejects_parent_traversal() {
        let root = tempfile::tempdir().expect("workspace");
        let workspace = WorkspaceIo::new(root.path()).expect("workspace IO");
        let requested = root.path().join("nested").join("..").join("file.txt");
        assert!(workspace.writable_path(&requested).is_err());
    }

    #[tokio::test]
    async fn permission_broker_rejects_unoffered_options() {
        let broker = PermissionBroker::default();
        let (sender, receiver) = oneshot::channel();
        broker.pending.lock().await.insert(
            "request".into(),
            PendingPermission {
                allowed_options: HashSet::from(["allow_once".into()]),
                sender,
            },
        );

        assert!(!broker.resolve("request", Some("always_allow".into())).await);
        assert_eq!(receiver.await.expect("permission response"), None);
    }
}
