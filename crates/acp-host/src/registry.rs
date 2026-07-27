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

    package_launch(manifest).with_context(|| {
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
    let package = package_launch_with_kind(agent);
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

fn package_launch(agent: &AgentManifest) -> Option<LaunchSpec> {
    package_launch_with_kind(agent).map(|(_, launch)| launch)
}

fn package_launch_with_kind(agent: &AgentManifest) -> Option<(&'static str, LaunchSpec)> {
    if let Some(target) = &agent.distribution.npx
        && let Some(command) = find_command("npx")
    {
        let mut args = vec!["--yes".to_owned(), target.package.clone()];
        args.extend(target.args.clone());
        return Some((
            "npx",
            LaunchSpec {
                command,
                args,
                env: target.env.clone(),
            },
        ));
    }
    if let Some(target) = &agent.distribution.uvx
        && let Some(command) = find_command("uvx")
    {
        let mut args = vec![target.package.clone()];
        args.extend(target.args.clone());
        return Some((
            "uvx",
            LaunchSpec {
                command,
                args,
                env: target.env.clone(),
            },
        ));
    }
    None
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
}
