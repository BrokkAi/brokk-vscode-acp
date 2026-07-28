use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Cursor, Read};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use bzip2::read::BzDecoder;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::Builder;

pub const DEFAULT_REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const MAX_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_REGISTRY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub struct Registry {
    pub version: String,
    pub agents: Vec<AgentManifest>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    pub distribution: Distribution,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Distribution {
    #[serde(default)]
    pub binary: HashMap<String, BinaryTarget>,
    #[serde(default)]
    pub npx: Option<PackageTarget>,
    #[serde(default)]
    pub uvx: Option<PackageTarget>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackageTarget {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LaunchSpec {
    pub command: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub license: Option<String>,
    pub distribution: Option<String>,
    pub installed: bool,
    pub available: bool,
    pub requirement: Option<String>,
    pub launch: Option<LaunchSpec>,
}

#[derive(Debug, Serialize, Deserialize)]
struct InstallMarker {
    id: String,
    version: String,
    command: PathBuf,
    args: Vec<String>,
    env: HashMap<String, String>,
}

pub async fn fetch_registry(url: &str, storage_dir: &Path) -> Result<(Registry, bool)> {
    fs::create_dir_all(storage_dir)
        .with_context(|| format!("creating registry cache {}", storage_dir.display()))?;
    let cache_path = storage_dir.join("registry.json");
    let client = reqwest::Client::builder()
        .user_agent(format!("brokk-vscode-acp/{}", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .context("creating registry HTTP client")?;

    let remote = async {
        let mut response = client
            .get(url)
            .send()
            .await
            .with_context(|| format!("fetching ACP registry from {url}"))?
            .error_for_status()
            .with_context(|| format!("ACP registry returned an error from {url}"))?;
        if response.content_length().unwrap_or(0) > MAX_REGISTRY_BYTES as u64 {
            bail!("ACP registry response exceeds the 16 MiB safety limit");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .context("reading ACP registry response")?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_REGISTRY_BYTES {
                bail!("ACP registry response exceeds the 16 MiB safety limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        let registry: Registry =
            serde_json::from_slice(&bytes).context("parsing ACP registry response")?;
        validate_registry(&registry)?;
        let temporary = cache_path.with_extension("json.tmp");
        fs::write(&temporary, &bytes)
            .with_context(|| format!("writing registry cache {}", temporary.display()))?;
        replace_file(&temporary, &cache_path)
            .with_context(|| format!("updating registry cache {}", cache_path.display()))?;
        Ok::<Registry, anyhow::Error>(registry)
    }
    .await;

    match remote {
        Ok(registry) => Ok((registry, false)),
        Err(remote_error) => {
            if fs::metadata(&cache_path)
                .map(|metadata| metadata.len() > MAX_REGISTRY_BYTES as u64)
                .unwrap_or(false)
            {
                bail!("{remote_error:#}; cached registry exceeds the 16 MiB safety limit");
            }
            let bytes = fs::read(&cache_path).with_context(|| {
                format!(
                    "{remote_error:#}; no cached registry was available at {}",
                    cache_path.display()
                )
            })?;
            let registry = serde_json::from_slice(&bytes)
                .with_context(|| format!("parsing cached registry {}", cache_path.display()))?;
            validate_registry(&registry)
                .with_context(|| format!("validating cached registry {}", cache_path.display()))?;
            Ok((registry, true))
        }
    }
}

pub fn summarize(registry: &Registry, storage_dir: &Path) -> Vec<AgentSummary> {
    let platform = platform_target();
    let mut agents = registry
        .agents
        .iter()
        .map(|agent| summarize_agent(agent, storage_dir, platform.as_deref()))
        .collect::<Vec<_>>();
    agents.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    agents
}

pub async fn install(
    registry: &Registry,
    agent_id: &str,
    storage_dir: &Path,
) -> Result<LaunchSpec> {
    let manifest = registry
        .agents
        .iter()
        .find(|agent| agent.id == agent_id)
        .with_context(|| format!("agent `{agent_id}` is not in the ACP registry"))?;

    if let Some(launch) = installed_binary(manifest, storage_dir) {
        return Ok(launch);
    }

    if let Some(platform) = platform_target()
        && let Some(target) = manifest.distribution.binary.get(&platform)
    {
        return install_binary(manifest, target, storage_dir).await;
    }

    package_launch(manifest, storage_dir).with_context(|| {
        format!(
            "{} {} has no distribution usable on this machine",
            manifest.name, manifest.version
        )
    })
}

fn summarize_agent(
    agent: &AgentManifest,
    storage_dir: &Path,
    platform: Option<&str>,
) -> AgentSummary {
    let installed = installed_binary(agent, storage_dir);
    let binary_for_platform = platform.and_then(|value| agent.distribution.binary.get(value));
    let package = package_launch_with_kind(agent, storage_dir);
    let (distribution, available, requirement, launch) = if let Some(launch) = installed {
        (Some("binary".to_owned()), true, None, Some(launch))
    } else if binary_for_platform.is_some() {
        (Some("binary".to_owned()), true, None, None)
    } else if let Some((kind, launch)) = package {
        (Some(kind.to_owned()), true, None, Some(launch))
    } else {
        let requirement = package_requirement(agent).or_else(|| {
            Some(
                platform
                    .map(|target| format!("No distribution for {target}"))
                    .unwrap_or_else(|| "Unsupported operating system or CPU architecture".into()),
            )
        });
        (None, false, requirement, None)
    };

    AgentSummary {
        id: agent.id.clone(),
        name: agent.name.clone(),
        version: agent.version.clone(),
        description: agent.description.clone(),
        repository: agent.repository.clone(),
        website: agent.website.clone(),
        license: agent.license.clone(),
        distribution,
        installed: launch
            .as_ref()
            .is_some_and(|value| value.command.is_absolute()),
        available,
        requirement,
        launch,
    }
}

fn package_requirement(agent: &AgentManifest) -> Option<String> {
    if agent.distribution.npx.is_some() && find_command("npx").is_none() {
        return Some("Requires npx (Node.js) on PATH".into());
    }
    if agent.distribution.uvx.is_some() && find_command("uvx").is_none() {
        return Some("Requires uvx (uv) on PATH".into());
    }
    None
}

fn package_launch(agent: &AgentManifest, storage_dir: &Path) -> Option<LaunchSpec> {
    package_launch_with_kind(agent, storage_dir).map(|(_, launch)| launch)
}

fn package_launch_with_kind(
    agent: &AgentManifest,
    storage_dir: &Path,
) -> Option<(&'static str, LaunchSpec)> {
    if let Some(target) = &agent.distribution.npx
        && let Some(command) = find_command("npx")
    {
        let mut args = vec!["--yes".to_owned(), target.package.clone()];
        args.extend(target.args.clone());
        let env = package_env(
            target,
            storage_dir,
            "npm_config_cache",
            Path::new("package-cache/npm"),
        );
        return Some(("npx", LaunchSpec { command, args, env }));
    }
    if let Some(target) = &agent.distribution.uvx
        && let Some(command) = find_command("uvx")
    {
        let mut args = vec![target.package.clone()];
        args.extend(target.args.clone());
        let env = package_env(
            target,
            storage_dir,
            "UV_CACHE_DIR",
            Path::new("package-cache/uv"),
        );
        return Some(("uvx", LaunchSpec { command, args, env }));
    }
    None
}

fn package_env(
    target: &PackageTarget,
    storage_dir: &Path,
    cache_variable: &str,
    cache_path: &Path,
) -> HashMap<String, String> {
    let mut env = target.env.clone();
    env.entry(cache_variable.to_owned())
        .or_insert_with(|| storage_dir.join(cache_path).to_string_lossy().into_owned());
    env
}

fn install_root(storage_dir: &Path, manifest: &AgentManifest) -> Result<PathBuf> {
    safe_path_component(&manifest.id)
        .with_context(|| format!("unsafe registry agent id `{}`", manifest.id))?;
    safe_path_component(&manifest.version)
        .with_context(|| format!("unsafe registry agent version `{}`", manifest.version))?;
    Ok(storage_dir
        .join("agents")
        .join(&manifest.id)
        .join(&manifest.version))
}

fn installed_binary(manifest: &AgentManifest, storage_dir: &Path) -> Option<LaunchSpec> {
    let root = install_root(storage_dir, manifest).ok()?;
    let marker: InstallMarker =
        serde_json::from_slice(&fs::read(root.join("install.json")).ok()?).ok()?;
    if marker.id != manifest.id || marker.version != manifest.version {
        return None;
    }
    let command = root.join(safe_relative_path(&marker.command).ok()?);
    if !command.is_file() {
        return None;
    }
    Some(LaunchSpec {
        command,
        args: marker.args,
        env: marker.env,
    })
}

async fn install_binary(
    manifest: &AgentManifest,
    target: &BinaryTarget,
    storage_dir: &Path,
) -> Result<LaunchSpec> {
    let command = safe_relative_command(&target.cmd)?;
    validate_download_url(&target.archive)?;
    let expected_checksum = target
        .sha256
        .as_deref()
        .context("registry binary distribution does not provide a SHA-256 checksum")?;
    let mut response = reqwest::Client::builder()
        .user_agent(format!("brokk-vscode-acp/{}", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .context("creating agent download client")?
        .get(&target.archive)
        .send()
        .await
        .with_context(|| format!("downloading {} {}", manifest.name, manifest.version))?
        .error_for_status()
        .with_context(|| format!("agent download failed for {}", target.archive))?;
    let content_length = response.content_length().unwrap_or(0);
    if content_length > MAX_ARCHIVE_BYTES as u64 {
        bail!("agent archive is larger than the 512 MiB safety limit");
    }
    let mut bytes = Vec::with_capacity(content_length.min(MAX_ARCHIVE_BYTES as u64) as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .context("reading downloaded agent archive")?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_ARCHIVE_BYTES {
            bail!("agent archive is larger than the 512 MiB safety limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    use std::fmt::Write as _;
    let actual =
        Sha256::digest(&bytes)
            .iter()
            .fold(String::with_capacity(64), |mut output, byte| {
                let _ = write!(output, "{byte:02x}");
                output
            });
    if !actual.eq_ignore_ascii_case(expected_checksum) {
        bail!("agent archive checksum mismatch: expected {expected_checksum}, got {actual}");
    }

    let destination = install_root(storage_dir, manifest)?;
    let parent = destination
        .parent()
        .context("agent install destination has no parent")?;
    fs::create_dir_all(parent)
        .with_context(|| format!("creating agent install directory {}", parent.display()))?;
    let temporary = Builder::new()
        .prefix(".install-")
        .tempdir_in(parent)
        .with_context(|| {
            format!(
                "creating temporary install directory in {}",
                parent.display()
            )
        })?;
    let temporary_path = temporary.path().to_owned();
    let archive_url = target.archive.clone();
    let archive_bytes = bytes;
    let command_for_extract = command.clone();

    tokio::task::spawn_blocking(move || {
        extract_archive(
            &archive_url,
            &archive_bytes,
            &temporary_path,
            &command_for_extract,
        )
    })
    .await
    .context("agent extraction task failed")??;

    let executable = temporary.path().join(&command);
    if !executable.is_file() {
        bail!(
            "registry command {} was not found in the downloaded archive",
            command.display()
        );
    }
    make_executable(&executable)?;
    let marker = InstallMarker {
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        command: command.clone(),
        args: target.args.clone(),
        env: target.env.clone(),
    };
    fs::write(
        temporary.path().join("install.json"),
        serde_json::to_vec_pretty(&marker)?,
    )
    .context("writing agent install marker")?;

    if destination.exists() {
        fs::remove_dir_all(&destination).with_context(|| {
            format!(
                "removing incomplete agent installation {}",
                destination.display()
            )
        })?;
    }
    fs::rename(temporary.path(), &destination)
        .with_context(|| format!("installing agent into {}", destination.display()))?;

    Ok(LaunchSpec {
        command: destination.join(command),
        args: target.args.clone(),
        env: target.env.clone(),
    })
}

fn extract_archive(url: &str, bytes: &[u8], destination: &Path, command: &Path) -> Result<()> {
    let normalized = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    if normalized.ends_with(".zip") {
        return extract_zip(bytes, destination);
    }
    if normalized.ends_with(".tar.gz") || normalized.ends_with(".tgz") {
        return extract_tar(GzDecoder::new(Cursor::new(bytes)), destination);
    }
    if normalized.ends_with(".tar.bz2") || normalized.ends_with(".tbz2") {
        return extract_tar(BzDecoder::new(Cursor::new(bytes)), destination);
    }

    let output = destination.join(command);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&output, bytes).with_context(|| format!("writing raw binary {}", output.display()))
}

fn extract_zip(bytes: &[u8], destination: &Path) -> Result<()> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).context("opening downloaded ZIP archive")?;
    let mut extracted_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .with_context(|| format!("reading ZIP entry {index}"))?;
        extracted_bytes = extracted_bytes
            .checked_add(entry.size())
            .context("ZIP archive expanded size overflowed")?;
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            bail!("agent archive expands beyond the 1 GiB safety limit");
        }
        let relative = entry
            .enclosed_name()
            .with_context(|| format!("unsafe path in ZIP entry {}", entry.name()))?
            .to_owned();
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file =
            File::create(&output).with_context(|| format!("creating {}", output.display()))?;
        io::copy(&mut entry, &mut file)
            .with_context(|| format!("extracting {}", output.display()))?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&output, fs::Permissions::from_mode(mode))?;
        }
    }
    Ok(())
}

fn extract_tar(reader: impl Read, destination: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(reader);
    let mut extracted_bytes = 0_u64;
    for entry in archive
        .entries()
        .context("reading downloaded tar archive")?
    {
        let mut entry = entry.context("reading tar entry")?;
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            bail!("agent tar archive contains an unsupported link or special file");
        }
        extracted_bytes = extracted_bytes
            .checked_add(entry.size())
            .context("tar archive expanded size overflowed")?;
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            bail!("agent archive expands beyond the 1 GiB safety limit");
        }
        if !entry
            .unpack_in(destination)
            .context("extracting tar entry")?
        {
            bail!("tar archive contained a path outside the install directory");
        }
    }
    Ok(())
}

fn safe_relative_command(command: &str) -> Result<PathBuf> {
    safe_relative_path(Path::new(command))
        .with_context(|| format!("registry command `{command}` is not a safe relative path"))
}

fn safe_relative_path(path: &Path) -> Result<PathBuf> {
    let mut safe = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => safe.push(value),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("path is not relative or contains traversal components")
            }
        }
    }
    if safe.as_os_str().is_empty() {
        bail!("registry command is empty");
    }
    Ok(safe)
}

fn safe_path_component(value: &str) -> Result<()> {
    let mut components = Path::new(value).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        bail!("value is not a single safe path component");
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+'))
    {
        bail!("value contains characters that are unsafe in portable paths");
    }
    Ok(())
}

fn replace_file(source: &Path, destination: &Path) -> Result<()> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(first_error) if destination.is_file() => {
            fs::remove_file(destination)?;
            fs::rename(source, destination).with_context(|| {
                format!(
                    "renaming {} to {} after replace failed: {first_error}",
                    source.display(),
                    destination.display()
                )
            })
        }
        Err(error) => Err(error.into()),
    }
}

fn validate_download_url(url: &str) -> Result<()> {
    let parsed =
        reqwest::Url::parse(url).with_context(|| format!("invalid archive URL `{url}`"))?;
    if !matches!(parsed.scheme(), "https" | "http") {
        bail!("agent archive URL must use HTTPS or HTTP");
    }
    Ok(())
}

fn validate_registry(registry: &Registry) -> Result<()> {
    let mut ids = HashSet::new();
    for agent in &registry.agents {
        safe_path_component(&agent.id)
            .with_context(|| format!("unsafe registry agent id `{}`", agent.id))?;
        safe_path_component(&agent.version)
            .with_context(|| format!("unsafe registry agent version `{}`", agent.version))?;
        if !ids.insert(&agent.id) {
            bail!("registry contains duplicate agent id `{}`", agent.id);
        }
        for target in agent.distribution.binary.values() {
            safe_relative_command(&target.cmd)?;
            validate_download_url(&target.archive)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(permissions.mode() | 0o700);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<()> {
    Ok(())
}

fn platform_target() -> Option<String> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        _ => return None,
    };
    let architecture = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        _ => return None,
    };
    Some(format!("{os}-{architecture}"))
}

fn find_command(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let extensions = command_extensions();
    for directory in std::env::split_paths(&path) {
        for extension in &extensions {
            let mut file_name = OsString::from(name);
            file_name.push(extension);
            let candidate = directory.join(file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn command_extensions() -> Vec<OsString> {
    #[cfg(windows)]
    {
        let configured =
            std::env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
        std::env::split_paths(&configured)
            .map(|path| path.into_os_string())
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![OsString::new()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;

    fn serve_once(path: &str, body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test HTTP server");
        let address = listener.local_addr().expect("test server address");
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept HTTP request");
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).expect("read HTTP request");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .expect("write HTTP headers");
            stream.write_all(&body).expect("write HTTP body");
        });
        format!("http://{address}{path}")
    }

    fn checksum(bytes: &[u8]) -> String {
        use std::fmt::Write as _;
        Sha256::digest(bytes)
            .iter()
            .fold(String::new(), |mut output, byte| {
                let _ = write!(output, "{byte:02x}");
                output
            })
    }

    fn manifest(distribution: Distribution) -> AgentManifest {
        AgentManifest {
            id: "test-agent".into(),
            name: "Test Agent".into(),
            version: "1.2.3".into(),
            description: "Test".into(),
            repository: None,
            website: None,
            license: None,
            distribution,
        }
    }

    #[test]
    fn parses_registry_package_distribution() {
        let registry: Registry = serde_json::from_value(serde_json::json!({
            "version": "1.0.0",
            "agents": [{
                "id": "codex-acp",
                "name": "Codex",
                "version": "1.1.7",
                "description": "ACP adapter",
                "distribution": {
                    "npx": { "package": "@agentclientprotocol/codex-acp@1.1.7" }
                }
            }]
        }))
        .expect("registry should parse");

        assert_eq!(registry.version, "1.0.0");
        assert_eq!(
            registry.agents[0]
                .distribution
                .npx
                .as_ref()
                .expect("npx target")
                .package,
            "@agentclientprotocol/codex-acp@1.1.7"
        );
    }

    #[test]
    fn rejects_unsafe_registry_commands() {
        assert!(safe_relative_command("../../bin/agent").is_err());
        assert!(safe_relative_command("/bin/agent").is_err());
        assert_eq!(
            safe_relative_command("./nested/agent").expect("safe command"),
            PathBuf::from("nested/agent")
        );
    }

    #[test]
    fn summarizes_missing_distribution_without_panicking() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let summary = summarize_agent(
            &manifest(Distribution::default()),
            temporary.path(),
            platform_target().as_deref(),
        );
        assert!(!summary.available);
        assert!(summary.requirement.is_some());
    }

    #[test]
    fn package_cache_is_owned_by_the_extension_without_overriding_registry_env() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let target = PackageTarget {
            package: "test-agent@1.2.3".into(),
            args: Vec::new(),
            env: HashMap::new(),
        };
        let env = package_env(
            &target,
            temporary.path(),
            "npm_config_cache",
            Path::new("package-cache/npm"),
        );
        assert_eq!(
            env.get("npm_config_cache"),
            Some(
                &temporary
                    .path()
                    .join("package-cache/npm")
                    .to_string_lossy()
                    .into_owned()
            )
        );

        let configured = PackageTarget {
            env: HashMap::from([("npm_config_cache".into(), "/custom/cache".into())]),
            ..target
        };
        let env = package_env(
            &configured,
            temporary.path(),
            "npm_config_cache",
            Path::new("package-cache/npm"),
        );
        assert_eq!(
            env.get("npm_config_cache").map(String::as_str),
            Some("/custom/cache")
        );
    }

    #[test]
    fn rejects_registry_path_traversal_and_duplicate_ids() {
        let unsafe_registry = Registry {
            version: "1".into(),
            agents: vec![AgentManifest {
                id: "../escape".into(),
                ..manifest(Distribution::default())
            }],
        };
        assert!(validate_registry(&unsafe_registry).is_err());
        assert!(safe_path_component("windows:escape").is_err());

        let agent = manifest(Distribution::default());
        let duplicate_registry = Registry {
            version: "1".into(),
            agents: vec![agent.clone(), agent],
        };
        assert!(validate_registry(&duplicate_registry).is_err());
    }

    #[test]
    fn replaces_existing_cache_file() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let source = temporary.path().join("new");
        let destination = temporary.path().join("registry.json");
        fs::write(&source, "new").expect("write source");
        fs::write(&destination, "old").expect("write destination");

        replace_file(&source, &destination).expect("replace destination");

        assert_eq!(
            fs::read_to_string(destination).expect("read destination"),
            "new"
        );
        assert!(!source.exists());
    }

    #[tokio::test]
    async fn fetches_validates_caches_and_falls_back_to_cached_registry() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let bytes = serde_json::to_vec(&serde_json::json!({
            "version": "test",
            "agents": [{
                "id": "cached-agent",
                "name": "Cached Agent",
                "version": "1.0.0",
                "description": "Test",
                "distribution": {}
            }]
        }))
        .expect("registry JSON");
        let url = serve_once("/registry.json", bytes.clone());
        let (registry, cached) = fetch_registry(&url, temporary.path())
            .await
            .expect("fetch registry");
        assert_eq!(registry.version, "test");
        assert!(!cached);
        assert_eq!(
            fs::read(temporary.path().join("registry.json")).expect("cached registry"),
            bytes
        );

        let (registry, cached) = fetch_registry("http://127.0.0.1:1/unavailable", temporary.path())
            .await
            .expect("fall back to cache");
        assert_eq!(registry.agents[0].id, "cached-agent");
        assert!(cached);

        let empty = tempfile::tempdir().expect("empty cache");
        assert!(
            fetch_registry("http://127.0.0.1:1/unavailable", empty.path())
                .await
                .expect_err("missing cache")
                .to_string()
                .contains("no cached registry")
        );
        fs::write(empty.path().join("registry.json"), b"not json").expect("invalid cache");
        assert!(
            fetch_registry("http://127.0.0.1:1/unavailable", empty.path())
                .await
                .expect_err("invalid cache")
                .to_string()
                .contains("parsing cached registry")
        );
    }

    #[tokio::test]
    async fn installs_raw_binary_and_reuses_verified_marker() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let binary = b"#!/bin/sh\nexit 0\n".to_vec();
        let archive = serve_once("/agent.bin?download=1", binary.clone());
        let platform = platform_target().expect("supported test platform");
        let distribution = Distribution {
            binary: HashMap::from([(
                platform,
                BinaryTarget {
                    archive,
                    cmd: "bin/test-agent".into(),
                    args: vec!["--stdio".into()],
                    env: HashMap::from([("TEST_ENV".into(), "set".into())]),
                    sha256: Some(checksum(&binary)),
                },
            )]),
            ..Distribution::default()
        };
        let registry = Registry {
            version: "test".into(),
            agents: vec![manifest(distribution)],
        };
        let incomplete = install_root(temporary.path(), &registry.agents[0]).expect("install root");
        fs::create_dir_all(&incomplete).expect("incomplete install");
        fs::write(incomplete.join("leftover"), "old").expect("old file");

        let launch = install(&registry, "test-agent", temporary.path())
            .await
            .expect("install binary");
        assert!(launch.command.is_file());
        assert_eq!(launch.args, vec!["--stdio"]);
        assert_eq!(launch.env.get("TEST_ENV").map(String::as_str), Some("set"));
        assert!(!incomplete.join("leftover").exists());
        let marker = fs::read(incomplete.join("install.json")).expect("install marker");
        assert!(
            serde_json::from_slice::<InstallMarker>(&marker).is_ok(),
            "marker is valid"
        );

        let cached = install(&registry, "test-agent", temporary.path())
            .await
            .expect("reuse installed binary");
        assert_eq!(cached, launch);
        let summary = summarize(&registry, temporary.path());
        assert!(summary[0].installed);
        assert_eq!(summary[0].distribution.as_deref(), Some("binary"));
        assert!(summary[0].launch.is_some());
        assert!(
            install(&registry, "missing", temporary.path())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn rejects_invalid_binary_install_metadata_and_checksums() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let platform = platform_target().expect("supported test platform");
        let target = |archive: String, checksum: Option<String>| BinaryTarget {
            archive,
            cmd: "agent".into(),
            args: Vec::new(),
            env: HashMap::new(),
            sha256: checksum,
        };
        let registry_with = |binary: BinaryTarget| Registry {
            version: "test".into(),
            agents: vec![manifest(Distribution {
                binary: HashMap::from([(platform.clone(), binary)]),
                ..Distribution::default()
            })],
        };

        let body = b"binary".to_vec();
        let no_checksum = registry_with(target(serve_once("/agent", body.clone()), None));
        assert!(
            install(&no_checksum, "test-agent", temporary.path())
                .await
                .expect_err("missing checksum")
                .to_string()
                .contains("does not provide")
        );
        let bad_checksum = registry_with(target(serve_once("/agent", body), Some("00".repeat(32))));
        assert!(
            install(&bad_checksum, "test-agent", temporary.path())
                .await
                .expect_err("checksum mismatch")
                .to_string()
                .contains("checksum mismatch")
        );
        assert!(validate_download_url("file:///tmp/agent").is_err());
        assert!(validate_download_url("not a URL").is_err());
    }

    #[test]
    fn extracts_supported_archives_and_rejects_unsafe_tar_entries() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        extract_archive(
            "https://example.test/raw?download=1",
            b"raw",
            temporary.path(),
            Path::new("nested/raw-agent"),
        )
        .expect("extract raw binary");
        assert_eq!(
            fs::read(temporary.path().join("nested/raw-agent")).expect("raw output"),
            b"raw"
        );

        let mut zip_cursor = Cursor::new(Vec::new());
        {
            let mut archive = zip::ZipWriter::new(&mut zip_cursor);
            let options = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
            archive
                .add_directory("bin/", options)
                .expect("add ZIP directory");
            archive
                .start_file("bin/zip-agent", options)
                .expect("add ZIP file");
            archive.write_all(b"zip").expect("write ZIP file");
            archive.finish().expect("finish ZIP");
        }
        let zip_output = tempfile::tempdir().expect("ZIP output");
        extract_archive(
            "https://example.test/agent.ZIP#asset",
            zip_cursor.get_ref(),
            zip_output.path(),
            Path::new("ignored"),
        )
        .expect("extract ZIP");
        assert_eq!(
            fs::read(zip_output.path().join("bin/zip-agent")).expect("ZIP output file"),
            b"zip"
        );

        let tar_bytes = {
            let mut bytes = Vec::new();
            {
                let mut archive = tar::Builder::new(&mut bytes);
                let mut header = tar::Header::new_gnu();
                header.set_size(3);
                header.set_mode(0o755);
                header.set_cksum();
                archive
                    .append_data(&mut header, "bin/tar-agent", Cursor::new(b"tar"))
                    .expect("append tar file");
                archive.finish().expect("finish tar");
            }
            bytes
        };
        let gzip = {
            use flate2::Compression;
            use flate2::write::GzEncoder;
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&tar_bytes).expect("gzip tar");
            encoder.finish().expect("finish gzip")
        };
        let gzip_output = tempfile::tempdir().expect("gzip output");
        extract_archive(
            "https://example.test/agent.tgz",
            &gzip,
            gzip_output.path(),
            Path::new("ignored"),
        )
        .expect("extract gzip tar");
        assert_eq!(
            fs::read(gzip_output.path().join("bin/tar-agent")).expect("tar output"),
            b"tar"
        );

        let bzip = {
            use bzip2::Compression;
            use bzip2::write::BzEncoder;
            let mut encoder = BzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&tar_bytes).expect("bzip tar");
            encoder.finish().expect("finish bzip")
        };
        let bzip_output = tempfile::tempdir().expect("bzip output");
        extract_archive(
            "https://example.test/agent.tbz2",
            &bzip,
            bzip_output.path(),
            Path::new("ignored"),
        )
        .expect("extract bzip tar");
        assert_eq!(
            fs::read(bzip_output.path().join("bin/tar-agent")).expect("bzip output"),
            b"tar"
        );

        let mut linked_tar = Vec::new();
        {
            let mut archive = tar::Builder::new(&mut linked_tar);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            header.set_link_name("../outside").expect("link target");
            header.set_cksum();
            archive
                .append_data(&mut header, "link", io::empty())
                .expect("append symlink");
            archive.finish().expect("finish linked tar");
        }
        assert!(
            extract_tar(Cursor::new(linked_tar), temporary.path())
                .expect_err("reject tar links")
                .to_string()
                .contains("unsupported")
        );
    }

    #[test]
    fn summarizes_binary_and_package_distributions_and_validates_markers() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let platform = platform_target().expect("supported test platform");
        let binary_manifest = manifest(Distribution {
            binary: HashMap::from([(
                platform.clone(),
                BinaryTarget {
                    archive: "https://example.test/agent".into(),
                    cmd: "agent".into(),
                    args: Vec::new(),
                    env: HashMap::new(),
                    sha256: Some("00".repeat(32)),
                },
            )]),
            ..Distribution::default()
        });
        let binary = summarize_agent(&binary_manifest, temporary.path(), Some(platform.as_str()));
        assert!(binary.available);
        assert!(!binary.installed);
        assert_eq!(binary.distribution.as_deref(), Some("binary"));

        let package_manifest = manifest(Distribution {
            npx: Some(PackageTarget {
                package: "test-agent@1.2.3".into(),
                args: vec!["--flag".into()],
                env: HashMap::new(),
            }),
            ..Distribution::default()
        });
        let package = summarize_agent(&package_manifest, temporary.path(), None);
        assert_eq!(package.distribution.as_deref(), Some("npx"));
        assert_eq!(
            package.launch.expect("npx launch").args,
            vec!["--yes", "test-agent@1.2.3", "--flag"]
        );

        let root = install_root(temporary.path(), &binary_manifest).expect("install root");
        fs::create_dir_all(&root).expect("install directory");
        fs::write(root.join("install.json"), b"not json").expect("invalid marker");
        assert!(installed_binary(&binary_manifest, temporary.path()).is_none());
        fs::write(
            root.join("install.json"),
            serde_json::to_vec(&InstallMarker {
                id: "other".into(),
                version: binary_manifest.version.clone(),
                command: "agent".into(),
                args: Vec::new(),
                env: HashMap::new(),
            })
            .expect("marker JSON"),
        )
        .expect("mismatched marker");
        assert!(installed_binary(&binary_manifest, temporary.path()).is_none());
    }

    #[test]
    fn path_command_and_registry_validation_cover_safe_and_unsafe_inputs() {
        assert!(safe_relative_path(Path::new("")).is_err());
        assert!(safe_path_component("").is_err());
        assert!(safe_path_component("two/parts").is_err());
        assert!(safe_path_component("safe-1.0+test").is_ok());
        assert!(
            install_root(
                Path::new("/tmp"),
                &AgentManifest {
                    version: "../bad".into(),
                    ..manifest(Distribution::default())
                }
            )
            .is_err()
        );
        assert!(replace_file(Path::new("/missing"), Path::new("/also-missing")).is_err());
        assert!(find_command("python3").is_some());
        assert!(find_command("definitely-not-a-real-brokk-command").is_none());
        assert!(!command_extensions().is_empty());

        let invalid_command = Registry {
            version: "test".into(),
            agents: vec![manifest(Distribution {
                binary: HashMap::from([(
                    "test".into(),
                    BinaryTarget {
                        archive: "https://example.test/agent".into(),
                        cmd: "../agent".into(),
                        args: Vec::new(),
                        env: HashMap::new(),
                        sha256: Some("00".repeat(32)),
                    },
                )]),
                ..Distribution::default()
            })],
        };
        assert!(validate_registry(&invalid_command).is_err());
        let invalid_url = Registry {
            version: "test".into(),
            agents: vec![manifest(Distribution {
                binary: HashMap::from([(
                    "test".into(),
                    BinaryTarget {
                        archive: "file:///tmp/agent".into(),
                        cmd: "agent".into(),
                        args: Vec::new(),
                        env: HashMap::new(),
                        sha256: Some("00".repeat(32)),
                    },
                )]),
                ..Distribution::default()
            })],
        };
        assert!(validate_registry(&invalid_url).is_err());
    }
}
