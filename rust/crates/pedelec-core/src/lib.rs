//! The Provider plumbing Pedelec's Rust workers share: executable discovery,
//! Antigravity workspace assets and the persistent bootstrap prompt.

use pedelec_shared::paths::path_for_external_use;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[cfg(windows)]
use std::collections::HashSet;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const PEDELEC_ANTIGRAVITY_AGENT_DIR: &str = ".agents/agents/pedelec-runtime";
/// How a bootstrap written by Pedelec begins; see `insert_antigravity_custom_agent_body`.
const PEDELEC_ANTIGRAVITY_AGENT_MARKER: &str = "---\nname: pedelec-runtime\n";

const PEDELEC_ANTIGRAVITY_AGENT_FILE: &str = "agent.md";

const PEDELEC_ANTIGRAVITY_HOOKS_FILE: &str = ".agents/hooks.json";

const PEDELEC_ANTIGRAVITY_HOOK_KEY: &str = "pedelec-provider-artifacts";

pub const MAX_ASSET_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;

const PROVIDER_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

const PROVIDER_PROBE_MAX_OUTPUT_BYTES: u64 = 64 * 1024;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PedelecError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl PedelecError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Value,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Some(details),
        }
    }
}

/// Waits until the initial provider snapshot has been installed.
///
/// The readiness handle is copied while briefly holding the runtime mutex and
/// the actual wait happens afterwards. This is important because the scan must
/// reacquire the runtime mutex to atomically install its completed snapshot.
/// Standalone provider discovery for hosts without a shared Core runtime. It uses
/// the same trusted PATH merge and version recognition as the Core provider scan.
pub fn resolve_provider_search_path() -> OsString {
    resolve_provider_path_value()
}

/// The newest recognized executable for `program` on `path_value`.
pub fn scan_provider_executable(program: &str, path_value: &OsString) -> Option<(PathBuf, String)> {
    discover_provider_candidates(program, path_value)
        .into_iter()
        .filter_map(|path| {
            provider_cli_version(&path, Some(path_value)).map(|version| (path, version))
        })
        .max_by(|(left_path, left), (right_path, right)| {
            left.cmp(right).then_with(|| left_path.cmp(right_path))
        })
        .map(|(path, version)| {
            let version = version
                .0
                .iter()
                .map(u64::to_string)
                .collect::<Vec<_>>()
                .join(".");
            (path, version)
        })
}

/// Writes the static Antigravity agent and artifact hooks into `workspace_path`
/// without a Core thread. Merges into an existing hooks.json and is idempotent.
pub fn ensure_antigravity_workspace_assets(workspace_path: &Path) -> Result<(), PedelecError> {
    ensure_antigravity_provider_artifact_hook(workspace_path)?;
    ensure_antigravity_custom_agent(workspace_path)
}

pub mod error_codes {
    pub const PROVIDER_BOOTSTRAP_ASSET_FAILED: &str = "PROVIDER_BOOTSTRAP_ASSET_FAILED";
}

#[derive(Debug, Clone, Serialize, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
struct ProviderVersion(Vec<u64>);

#[derive(Debug, Clone)]
enum ProviderVersionProbeOutcome {
    Recognized(ProviderVersion),
    Unrecognized,
    Failed,
}

fn resolve_provider_path_value() -> OsString {
    let process_path = env::var_os("PATH");
    #[cfg(target_os = "macos")]
    let login_shell_path = resolve_macos_login_shell_path();
    #[cfg(not(target_os = "macos"))]
    let login_shell_path = None;

    merge_provider_paths(
        process_path.as_ref(),
        login_shell_path.as_ref(),
        provider_fallback_paths(),
    )
}

fn provider_fallback_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(windows)]
    if let Ok(hkcu) =
        winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).open_subkey("Environment")
    {
        if let Ok(value) = hkcu.get_value::<OsString, _>("Path") {
            paths.extend(env::split_paths(&value));
        }
    }

    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".pedelec"));
        #[cfg(windows)]
        paths.extend([
            home.join("AppData/Local/Programs/OpenAI/Codex/bin"),
            home.join("AppData/Local/agy/bin"),
            home.join(".opencode/bin"),
            home.join(".local/bin"),
            home.join("AppData/Roaming/npm"),
        ]);
        #[cfg(not(windows))]
        paths.extend([home.join(".local/bin"), home.join(".opencode/bin")]);
        #[cfg(target_os = "macos")]
        paths.extend([
            home.join(".volta/bin"),
            home.join(".asdf/shims"),
            home.join(".local/share/mise/shims"),
            home.join("Library/pnpm"),
            home.join(".bun/bin"),
        ]);
    }
    #[cfg(target_os = "macos")]
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/local/bin"),
    ]);
    paths
}

fn merge_provider_paths(
    process_path: Option<&OsString>,
    login_shell_path: Option<&OsString>,
    fallback_paths: Vec<PathBuf>,
) -> OsString {
    let mut paths = process_path.map_or_else(Vec::new, |value| env::split_paths(value).collect());
    if let Some(login_shell_path) = login_shell_path {
        paths.extend(env::split_paths(login_shell_path));
    }
    paths.extend(fallback_paths);

    let mut normalized = Vec::new();
    for path in paths {
        if !path.is_dir() {
            continue;
        }
        append_unique_provider_path(&mut normalized, path);
    }
    env::join_paths(normalized).unwrap_or_default()
}

fn append_unique_provider_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    let duplicate = paths.iter().any(|existing| {
        #[cfg(windows)]
        {
            existing
                .to_string_lossy()
                .eq_ignore_ascii_case(&path.to_string_lossy())
        }
        #[cfg(not(windows))]
        {
            existing == &path
        }
    });
    if !duplicate {
        paths.push(path);
    }
}

#[cfg(any(target_os = "macos", test))]
const MACOS_PATH_MARKER_COMMAND: &str =
    "printf '__PEDELEC_PATH_START__%s__PEDELEC_PATH_END__\\n' \"$PATH\"";

#[cfg(any(target_os = "macos", test))]
const MACOS_PATH_MARKER_START: &str = "__PEDELEC_PATH_START__";

#[cfg(any(target_os = "macos", test))]
const MACOS_PATH_MARKER_END: &str = "__PEDELEC_PATH_END__";

#[cfg(target_os = "macos")]
const MACOS_LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(3);

#[cfg(any(target_os = "macos", test))]
fn macos_shell_probe_arguments(_shell_path: &Path) -> Vec<Vec<&'static str>> {
    // PATH discovery must not intentionally run interactive shell startup files.
    vec![vec!["-l", "-c", MACOS_PATH_MARKER_COMMAND]]
}

#[cfg(target_os = "macos")]
fn resolve_macos_login_shell_path() -> Option<OsString> {
    let shell_path = env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && is_provider_executable(path))
        .or_else(|| {
            [PathBuf::from("/bin/zsh"), PathBuf::from("/bin/bash")]
                .into_iter()
                .find(|path| is_provider_executable(path))
        })?;

    resolve_macos_shell_path_with_strategies(
        &shell_path,
        Instant::now() + MACOS_LOGIN_SHELL_TIMEOUT,
    )
}

#[cfg(any(target_os = "macos", all(test, unix)))]
fn resolve_macos_shell_path_with_strategies(
    shell_path: &Path,
    deadline: Instant,
) -> Option<OsString> {
    let mut paths = Vec::new();
    for args in macos_shell_probe_arguments(shell_path) {
        if Instant::now() >= deadline {
            break;
        }
        if let Some(path) = probe_shell_path(shell_path, &args, deadline) {
            paths.push(path);
        }
    }
    merge_shell_probe_paths(&paths)
}

#[cfg(any(target_os = "macos", all(test, unix)))]
fn probe_shell_path(shell_path: &Path, args: &[&str], deadline: Instant) -> Option<OsString> {
    if Instant::now() >= deadline {
        log_macos_login_shell_failure(shell_path, "timeout");
        return None;
    }

    let mut command = Command::new(shell_path);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else {
        log_macos_login_shell_failure(shell_path, "spawn");
        return None;
    };

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        log_macos_login_shell_failure(shell_path, "stdout");
        return None;
    };
    let (output_sender, output_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let result = stdout
            .take(u64::MAX)
            .read_to_end(&mut output)
            .map(|_| output);
        let _ = output_sender.send(result);
    });

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    let _ = child.kill();
                    let _ = child.wait();
                    log_macos_login_shell_failure(shell_path, "timeout");
                    break None;
                }
                std::thread::sleep(remaining.min(Duration::from_millis(10)));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                log_macos_login_shell_failure(shell_path, "wait");
                break None;
            }
        }
    }?;

    let remaining = deadline.saturating_duration_since(Instant::now());
    let output = match output_receiver.recv_timeout(remaining) {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => {
            log_macos_login_shell_failure(shell_path, "read");
            return None;
        }
        Err(_) => {
            log_macos_login_shell_failure(shell_path, "read-timeout");
            return None;
        }
    };
    if !status.success() {
        log_macos_login_shell_failure(shell_path, "exit");
        return None;
    }
    let path = parse_login_shell_path_output(&output);
    if path.is_none() {
        log_macos_login_shell_failure(shell_path, "parse");
    }
    path
}

#[cfg(any(target_os = "macos", all(test, unix)))]
fn merge_shell_probe_paths(paths: &[OsString]) -> Option<OsString> {
    let mut merged = Vec::new();
    for value in paths {
        for path in env::split_paths(value) {
            if !path.as_os_str().is_empty() {
                append_unique_provider_path(&mut merged, path);
            }
        }
    }
    if merged.is_empty() {
        None
    } else {
        env::join_paths(merged).ok()
    }
}

#[cfg(any(target_os = "macos", all(test, unix)))]
fn log_macos_login_shell_failure(shell_path: &Path, category: &str) {
    #[cfg(debug_assertions)]
    eprintln!(
        "macOS login shell PATH lookup failed: shell={} failure={}",
        shell_path.display(),
        category
    );
}

#[cfg(any(target_os = "macos", test))]
fn parse_login_shell_path_output(output: &[u8]) -> Option<OsString> {
    let start = output
        .windows(MACOS_PATH_MARKER_START.len())
        .position(|window| window == MACOS_PATH_MARKER_START.as_bytes())?
        + MACOS_PATH_MARKER_START.len();
    let end = output[start..]
        .windows(MACOS_PATH_MARKER_END.len())
        .position(|window| window == MACOS_PATH_MARKER_END.as_bytes())?
        + start;
    let path = std::str::from_utf8(&output[start..end]).ok()?.trim();
    if path.is_empty()
        || !env::split_paths(OsString::from(path).as_os_str())
            .any(|entry| !entry.as_os_str().is_empty())
    {
        return None;
    }
    Some(OsString::from(path))
}

fn discover_provider_candidates(program: &str, path_value: &OsString) -> Vec<PathBuf> {
    let path_dirs = env::split_paths(path_value).collect::<Vec<_>>();
    let candidates =
        deduplicate_provider_candidates(provider_binary_lookup_candidates(program, &path_dirs));
    candidates
        .into_iter()
        .filter(|path| is_provider_executable(path))
        .collect()
}

fn deduplicate_provider_candidates(mut candidates: Vec<PathBuf>) -> Vec<PathBuf> {
    candidates.sort();
    candidates.dedup();
    #[cfg(windows)]
    {
        let mut identities = HashSet::new();
        candidates.retain(|path| {
            normalized_provider_candidate_identity(path)
                .map_or(true, |identity| identities.insert(identity))
        });
    }
    candidates
}

#[cfg(windows)]
fn normalized_provider_candidate_identity(path: &Path) -> Option<String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir().ok()?.join(path)
    };
    let identity = absolute.to_str()?;
    Some(identity.replace('/', "\\").to_lowercase())
}

fn is_provider_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn provider_cli_version(path: &Path, path_value: Option<&OsString>) -> Option<ProviderVersion> {
    match provider_cli_version_probe(path, path_value) {
        ProviderVersionProbeOutcome::Recognized(version) => Some(version),
        ProviderVersionProbeOutcome::Unrecognized | ProviderVersionProbeOutcome::Failed => None,
    }
}

fn provider_cli_version_probe(
    path: &Path,
    path_value: Option<&OsString>,
) -> ProviderVersionProbeOutcome {
    let output = run_bounded_provider_probe({
        let mut command = provider_version_command(path, path_value);
        command.arg("--version");
        command
    });
    let Ok(output) = output else {
        return ProviderVersionProbeOutcome::Failed;
    };
    if !output.status.success() {
        return ProviderVersionProbeOutcome::Failed;
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    match parse_provider_version(&text) {
        Some(version) => ProviderVersionProbeOutcome::Recognized(version),
        None => ProviderVersionProbeOutcome::Unrecognized,
    }
}

/// Run a provider discovery command with both a time and output bound. A
/// provider executable is user-controlled and may be a wrapper that starts a
/// long-lived process, so normal scans must never wait indefinitely or retain
/// an unbounded help/version response.
fn run_bounded_provider_probe(mut command: Command) -> Result<Output, ()> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|_| ())?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(());
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(());
    };
    let (stdout_sender, stdout_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let result = read_bounded_provider_probe_output(stdout);
        let _ = stdout_sender.send(result);
    });
    let (stderr_sender, stderr_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let result = read_bounded_provider_probe_output(stderr);
        let _ = stderr_sender.send(result);
    });

    let deadline = Instant::now() + PROVIDER_PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(());
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(());
            }
        }
    }?;

    let stdout = stdout_receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| ())?
        .map_err(|_| ())?;
    let stderr = stderr_receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| ())?
        .map_err(|_| ())?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn read_bounded_provider_probe_output(reader: impl Read) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    reader
        .take(PROVIDER_PROBE_MAX_OUTPUT_BYTES.saturating_add(1))
        .read_to_end(&mut output)?;
    if output.len() as u64 > PROVIDER_PROBE_MAX_OUTPUT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "provider probe output exceeded the collection limit",
        ));
    }
    Ok(output)
}

fn provider_version_command(path: &Path, path_value: Option<&OsString>) -> Command {
    #[cfg(windows)]
    {
        let is_script_wrapper = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat")
            });
        let mut command = if is_script_wrapper {
            let mut command = Command::new("cmd.exe");
            command.arg("/d").arg("/c").arg("call").arg(path);
            command
        } else {
            Command::new(path)
        };
        if let Some(path_value) = path_value {
            command.env("PATH", path_value);
        }
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    #[cfg(not(windows))]
    {
        let mut command = Command::new(path);
        if let Some(path_value) = path_value {
            command.env("PATH", path_value);
        }
        command
    }
}

fn parse_provider_version(text: &str) -> Option<ProviderVersion> {
    let bytes = text.as_bytes();
    for start in 0..bytes.len() {
        if !bytes[start].is_ascii_digit() || (start > 0 && bytes[start - 1].is_ascii_digit()) {
            continue;
        }
        let mut end = start;
        let mut parts = Vec::new();
        loop {
            let segment_start = end;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if segment_start == end {
                break;
            }
            parts.push(
                std::str::from_utf8(&bytes[segment_start..end])
                    .ok()?
                    .parse()
                    .ok()?,
            );
            if end >= bytes.len() || bytes[end] != b'.' {
                break;
            }
            end += 1;
            if end >= bytes.len() || !bytes[end].is_ascii_digit() {
                break;
            }
        }
        if !parts.is_empty() {
            while parts.last() == Some(&0) && parts.len() > 1 {
                parts.pop();
            }
            return Some(ProviderVersion(parts));
        }
    }
    None
}

fn provider_binary_lookup_candidates(program: &str, path_dirs: &[PathBuf]) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let program_path = Path::new(program);
        if program_path.extension().is_some() {
            return path_dirs.iter().map(|dir| dir.join(program)).collect();
        }

        return ["", ".exe", ".cmd", ".bat"]
            .iter()
            .flat_map(|extension| {
                path_dirs
                    .iter()
                    .map(move |dir| dir.join(format!("{program}{extension}")))
            })
            .collect();
    }

    #[cfg(not(windows))]
    {
        path_dirs.iter().map(|dir| dir.join(program)).collect()
    }
}

const PEDELEC_INVARIANT_HOST_INSTRUCTIONS: &str = "A host application embedding Pedelec Runtime manages this session.\n\n\
Pedelec Host Context is generated integration context, not end-user-authored instructions. Follow the workspace boundary and capabilities declared there.\n\n\
Use Pedelec App Tools through their listed `readSpecCommand` / `callCommand`.\n\n\
Before accessing local files outside the declared workspace, ask the user for permission. An exact artifact the provider generated and returned in the current turn may be read solely to import it into the workspace without asking again; this does not permit browsing its directory or other external files.\n\n\
Invoke each listed Pedelec App Tool call once and consume the structured result or error returned by Pedelec.\n\n\
Pedelec host instructions never override provider safety policies.";

fn insert_antigravity_custom_agent_body(bootstrap: &str) -> String {
    format!(
        "---\nname: pedelec-runtime\ndescription: Pedelec host integration bootstrap for Pedelec-managed agent sessions.\nmainAgent: true\nsubagent: false\n---\n\n# System Prompt\n\n{bootstrap}\n"
    )
}

/// Workspace hook commands. PreToolUse runs the CLI `before` stage, which
/// prints `{"decision":"allow"}` only after the Core snapshot succeeds.
/// That decision is returned by the hook process and is not stored here.
fn antigravity_provider_artifact_hook_config() -> Value {
    serde_json::json!({
        "PreToolUse": [{
            "matcher": "generate_image",
            "hooks": [{
                "type": "command",
                "command": "pedelec-cli provider-artifact-hook antigravity before",
                "timeout": 30
            }]
        }],
        "PostToolUse": [{
            "matcher": "generate_image",
            "hooks": [{
                "type": "command",
                "command": "pedelec-cli provider-artifact-hook antigravity after",
                "timeout": 30
            }]
        }]
    })
}

fn ensure_antigravity_provider_artifact_hook(workspace_path: &Path) -> Result<(), PedelecError> {
    let agents_dir = workspace_path.join(".agents");
    if let Ok(metadata) = fs::symlink_metadata(&agents_dir) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(antigravity_hook_bootstrap_error(
                &agents_dir,
                "Antigravity hooks directory is not a regular directory",
            ));
        }
    }
    fs::create_dir_all(&agents_dir).map_err(|error| {
        antigravity_hook_bootstrap_error(
            &agents_dir,
            &format!("failed to create Antigravity hooks directory: {error}"),
        )
    })?;

    let hooks_path = workspace_path.join(PEDELEC_ANTIGRAVITY_HOOKS_FILE);
    let original = match fs::symlink_metadata(&hooks_path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(antigravity_hook_bootstrap_error(
                    &hooks_path,
                    "Antigravity hooks.json is not a regular file",
                ));
            }
            Some(fs::read(&hooks_path).map_err(|error| {
                antigravity_hook_bootstrap_error(
                    &hooks_path,
                    &format!("failed to read Antigravity hooks.json: {error}"),
                )
            })?)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(antigravity_hook_bootstrap_error(
                &hooks_path,
                &format!("failed to inspect Antigravity hooks.json: {error}"),
            ));
        }
    };
    let mut hooks = match original.as_deref() {
        Some(bytes) => serde_json::from_slice::<Value>(bytes).map_err(|error| {
            antigravity_hook_bootstrap_error(
                &hooks_path,
                &format!("Antigravity hooks.json contains malformed JSON: {error}"),
            )
        })?,
        None => serde_json::json!({}),
    };
    let Some(hook_map) = hooks.as_object_mut() else {
        return Err(antigravity_hook_bootstrap_error(
            &hooks_path,
            "Antigravity hooks.json must contain a JSON object",
        ));
    };
    let expected = antigravity_provider_artifact_hook_config();
    if hook_map.get(PEDELEC_ANTIGRAVITY_HOOK_KEY) == Some(&expected) {
        return Ok(());
    }
    hook_map.insert(PEDELEC_ANTIGRAVITY_HOOK_KEY.to_string(), expected);
    let serialized = serde_json::to_vec_pretty(&hooks).map_err(|error| {
        antigravity_hook_bootstrap_error(
            &hooks_path,
            &format!("failed to encode Antigravity hooks.json: {error}"),
        )
    })?;
    write_antigravity_hooks_atomically(&hooks_path, original.as_deref(), &serialized).map_err(
        |error| {
            antigravity_hook_bootstrap_error(
                &hooks_path,
                &format!("failed to atomically update Antigravity hooks.json: {error}"),
            )
        },
    )
}

fn antigravity_hook_bootstrap_error(path: &Path, message: &str) -> PedelecError {
    PedelecError::with_details(
        error_codes::PROVIDER_BOOTSTRAP_ASSET_FAILED,
        message,
        serde_json::json!({
            "provider":"antigravity",
            "asset":"hooks.json",
            "path":path_for_external_use(path),
        }),
    )
}

fn write_antigravity_hooks_atomically(
    path: &Path,
    expected_existing: Option<&[u8]>,
    contents: &[u8],
) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Antigravity hooks path has no parent"))?;
    let temp = parent.join(format!("hooks.json.{}.tmp", Uuid::new_v4().simple()));
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        output.write_all(contents)?;
        output.sync_all()?;
        drop(output);

        let current = match fs::read(path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        if current.as_deref() != expected_existing {
            return Err(io::Error::other(
                "Antigravity hooks.json changed during update",
            ));
        }
        replace_file_atomically(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(not(windows))]
fn replace_file_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let success = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Materializes the static Antigravity workspace agent required by the
/// persistent `--agent pedelec-runtime` launch contract.
fn antigravity_custom_agent_is_replaceable(agent_path: &Path) -> bool {
    match fs::symlink_metadata(agent_path) {
        Err(error) => error.kind() == io::ErrorKind::NotFound,
        Ok(metadata) if !metadata.is_file() => false,
        Ok(_) => fs::read_to_string(agent_path)
            .is_ok_and(|content| content.starts_with(PEDELEC_ANTIGRAVITY_AGENT_MARKER)),
    }
}

fn ensure_antigravity_custom_agent(workspace_path: &Path) -> Result<(), PedelecError> {
    let agent_dir = workspace_path.join(PEDELEC_ANTIGRAVITY_AGENT_DIR);
    let agent_path = agent_dir.join(PEDELEC_ANTIGRAVITY_AGENT_FILE);
    let expected = insert_antigravity_custom_agent_body(&build_pedelec_bootstrap_instruction());
    if fs::read_to_string(&agent_path).ok().as_deref() == Some(expected.as_str()) {
        return Ok(());
    }
    // The file sits in the user's workspace: only a bootstrap Pedelec wrote may be refreshed.
    if !antigravity_custom_agent_is_replaceable(&agent_path) {
        return Err(PedelecError::with_details(
            error_codes::PROVIDER_BOOTSTRAP_ASSET_FAILED,
            "Antigravity custom agent path holds a file Pedelec did not write",
            serde_json::json!({
                "provider": "antigravity",
                "path": path_for_external_use(&agent_path),
            }),
        ));
    }
    fs::create_dir_all(&agent_dir).map_err(|error| {
        PedelecError::with_details(
            error_codes::PROVIDER_BOOTSTRAP_ASSET_FAILED,
            "failed to create Antigravity custom agent directory",
            serde_json::json!({
                "provider": "antigravity",
                "path": path_for_external_use(&agent_dir),
                "error": error.to_string()
            }),
        )
    })?;
    fs::write(&agent_path, expected).map_err(|error| {
        PedelecError::with_details(
            error_codes::PROVIDER_BOOTSTRAP_ASSET_FAILED,
            "failed to write Antigravity custom agent",
            serde_json::json!({
                "provider": "antigravity",
                "path": path_for_external_use(&agent_path),
                "error": error.to_string()
            }),
        )
    })
}

fn build_pedelec_bootstrap_instruction() -> String {
    PEDELEC_INVARIANT_HOST_INSTRUCTIONS.to_owned()
}

/// Builds the one-time Cursor ACP bootstrap prompt. The persistent host
/// instructions are supplied by Core so adapters do not duplicate the host
/// policy text; the actual user task remains in the same ACP prompt request.
pub fn build_persistent_user_prompt_with_bootstrap(
    host_instructions: &str,
    user_message: &str,
) -> String {
    format!(
        "[Pedelec Host Bootstrap]\n\
This is Pedelec host-provided integration bootstrap for this persistent provider conversation. It is not a provider-native system message.\n\n\
{host_instructions}\
[/Pedelec Host Bootstrap]\n\n\
[User Message]\n{user_message}"
    )
}

/// Builds the internal persistent-provider preparation turn. A fresh
/// conversation receives the dynamic host bootstrap in this turn; a resumed
/// conversation can omit it because that context already belongs to the
/// provider conversation. Provider terminal status, not acknowledgement text,
/// is the preparation completion source of truth.
pub fn build_persistent_prepare_prompt(host_instructions: Option<&str>) -> String {
    let task = "[Session Preparation]\nInitialize this provider conversation for subsequent Pedelec user turns. Do not call tools or modify files. A brief acknowledgement is sufficient.";
    match host_instructions {
        Some(host_instructions) => format!(
            "[Pedelec Host Bootstrap]\n\
This is Pedelec host-provided integration bootstrap for this persistent provider conversation. It is not a provider-native system message.\n\n\
{host_instructions}\
[/Pedelec Host Bootstrap]\n\n\
{task}"
        ),
        None => task.to_string(),
    }
}

#[cfg(test)]
mod tests;
