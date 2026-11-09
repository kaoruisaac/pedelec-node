//! Pure validation shared by private provider integrations; no Host business tools.
use crate::{
    protocol::{self, HostToolDescriptor},
    IpcFailure,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::OnceLock,
};
pub(crate) const CLI_RUNTIME_FILE_ENV: &str = "PEDELEC_CORE_IPC_RUNTIME_FILE";
const MAX_TOOLS: usize = 64;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_TOOL_DESCRIPTION_BYTES: usize = 8 * 1024;
const MAX_TOOL_SCHEMA_BYTES: usize = 64 * 1024;

pub(crate) fn valid_provider_session_id(value: &str) -> bool {
    protocol::valid_id(value) && value.trim() == value && !value.chars().any(char::is_control)
}

pub(crate) fn validate_reason(reason: &str) -> Result<(), IpcFailure> {
    if reason.trim().is_empty() || reason.len() > 2048 {
        return Err(IpcFailure::new(
            "INVALID_INPUT",
            "reason is empty or too long",
        ));
    }
    Ok(())
}

pub(crate) fn validate_host_instructions(instructions: &str) -> Result<(), IpcFailure> {
    // Host text (16 KiB at the SDK) plus the CLI guidance for up to 64 registered Tools.
    if instructions.len() > 64 * 1024 || instructions.contains('\0') {
        return Err(IpcFailure::new(
            "INVALID_INPUT",
            "host instructions are invalid",
        ));
    }
    Ok(())
}

pub(crate) fn canonical_workdir(raw: &str) -> Result<PathBuf, IpcFailure> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(IpcFailure::new(
            "INVALID_INPUT",
            "serverWorkdir must be absolute",
        ));
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| IpcFailure::new("INVALID_INPUT", "serverWorkdir is unavailable"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(IpcFailure::new(
            "INVALID_INPUT",
            "serverWorkdir is not a safe directory",
        ));
    }
    path.canonicalize()
        .map_err(|_| IpcFailure::new("INVALID_INPUT", "serverWorkdir is unavailable"))
}

/// Neutral snapshot limits for every Provider. Node owns schemas, validation and handlers;
/// descriptors only size-check here because they reach the Agent through `tool-spec`.
pub(crate) fn validate_tools(tools: &[HostToolDescriptor]) -> Result<(), IpcFailure> {
    if tools.len() > MAX_TOOLS {
        return Err(IpcFailure::new(
            "INVALID_INPUT",
            "too many tools were registered",
        ));
    }
    let mut names = HashSet::new();
    for tool in tools {
        if !names.insert(tool.name.as_str()) {
            return Err(IpcFailure::new("INVALID_INPUT", "duplicate tool name"));
        }
        let named = tool.name.len() <= MAX_TOOL_NAME_BYTES
            && tool
                .name
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
            && tool
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        let schema_bytes = serde_json::to_vec(&tool.args_schema).map_or(usize::MAX, |v| v.len());
        if !named
            || tool.description.len() > MAX_TOOL_DESCRIPTION_BYTES
            || schema_bytes > MAX_TOOL_SCHEMA_BYTES
        {
            return Err(IpcFailure::new(
                "INVALID_INPUT",
                "tool descriptor is outside its limits",
            ));
        }
    }
    Ok(())
}

/// The SDK's Session endpoint file, set on this Worker before it starts. Every Provider
/// passes it to its child explicitly, so its shell can reach `pedelec-cli`. Absent only
/// for tool-free fixtures; a Session with Tools refuses to start without it.
pub(crate) fn cli_runtime_file(needs_tools: bool) -> Result<Option<OsString>, IpcFailure> {
    let runtime =
        std::env::var_os(CLI_RUNTIME_FILE_ENV).filter(|value| Path::new(value).is_absolute());
    if needs_tools && runtime.is_none() {
        return Err(IpcFailure::new(
            "CLI_UNAVAILABLE",
            "Session CLI endpoint is required",
        ));
    }
    Ok(runtime)
}

/// One row per Provider for the Server's capability catalog. Host paths stay on this
/// machine: only the local Server reads them, to run a Provider's own model listing.
pub(crate) fn provider_scan() -> Value {
    let row = |provider: Option<ResolvedProvider>| match provider {
        Some(found) => json!({"available":true,"path":found.path,"version":found.version}),
        None => json!({"available":false}),
    };
    json!({
        "codex": row(resolve_provider("PEDELEC_CODEX_PATH", "codex")),
        "claude": row(resolve_provider("PEDELEC_CLAUDE_PATH", "claude")),
        "opencode": row(resolve_provider("PEDELEC_OPENCODE_PATH", "opencode")),
        "cursor": row(resolve_provider("PEDELEC_CURSOR_PATH", "cursor-agent")),
        "antigravity": row(resolve_provider("PEDELEC_ANTIGRAVITY_PATH", "agy")),
        "ollama": {"available":packaged_binary("pedelec-agent").is_some()},
    })
}

/// Trusted discovery shared by every provider, on the same PATH merge as the upstream
/// provider scan so a GUI launch still finds user-installed CLIs. Workspace-relative
/// PATH entries are dropped; only the trusted `env_key` override can replace the scan.
pub(crate) struct ResolvedProvider {
    pub(crate) path: PathBuf,
    pub(crate) version: Option<String>,
}

fn absolute_search_path() -> &'static OsString {
    static SEARCH_PATH: OnceLock<OsString> = OnceLock::new();
    SEARCH_PATH.get_or_init(|| {
        let merged = pedelec_core::resolve_provider_search_path();
        let absolute = std::env::split_paths(&merged).filter(|path| path.is_absolute());
        std::env::join_paths(absolute).unwrap_or(merged)
    })
}

/// PATH for provider children: SDK-prefixed helper directory first, then the merged scan.
pub(crate) fn provider_child_path() -> OsString {
    absolute_search_path().clone()
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

pub(crate) fn resolve_provider(env_key: &str, program: &str) -> Option<ResolvedProvider> {
    if let Some(value) = std::env::var_os(env_key) {
        let path = PathBuf::from(value);
        return (path.is_absolute() && is_executable(&path)).then_some(ResolvedProvider {
            path,
            version: None,
        });
    }
    pedelec_core::scan_provider_executable(program, absolute_search_path()).map(
        |(path, version)| ResolvedProvider {
            path,
            version: Some(version),
        },
    )
}

/// A helper shipped beside this Worker; never resolved through PATH or the workspace.
pub(crate) fn packaged_binary(name: &str) -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let candidate = current.parent()?.join(file);
    if candidate.is_file() {
        candidate.canonicalize().ok()
    } else {
        None
    }
}

/// Optional Server-owned absolute directory; a symlink or a file is refused.
pub(crate) fn trusted_directory(raw: Option<&str>) -> Result<Option<PathBuf>, IpcFailure> {
    raw.map(|value| {
        let path = Path::new(value);
        let invalid = || IpcFailure::new("INVALID_INPUT", "trusted directory is invalid");
        pedelec_shared::storage::directory(path).map_err(|_| invalid())?;
        Ok(path.to_path_buf())
    })
    .transpose()
}
