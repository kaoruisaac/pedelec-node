use super::cancellation::{interrupted_error, TurnCancellation};
use super::config::ToolHostConfig;
use super::conversation::InferenceAttachment;
use super::error::AgentError;
use super::sandbox::Sandbox;
use super::tavily::TavilyRoundWrapper;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

fn tool_def(name: &str, description: &str, input_schema: Value) -> AgentToolDefinition {
    AgentToolDefinition {
        name: name.to_string(),
        description: description.to_string(),
        input_schema,
    }
}

pub fn agent_tool_definitions(vision: bool, web_search_enabled: bool) -> Vec<AgentToolDefinition> {
    let mut definitions = vec![
        tool_def(
            "fs.list_text_files",
            "List readable UTF-8 text files inside the sandbox.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "dir": { "type": "string", "default": "." },
                    "maxDepth": { "type": "integer", "default": 3 }
                },
                "additionalProperties": false
            }),
        ),
        tool_def(
            "bash",
            "Run a restricted Pedelec helper command. This is not a full shell: only Pedelec App Tool commands through `pedelec-cli` are permitted. To pass long or multi-line text, put it in the stdin field unescaped and end the tool-call command with `--stdin-field <argument-name>`; that argument then holds the stdin text.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "timeoutMs": { "type": "integer" },
                    "stdin": { "type": "string" }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "fs.read_text_file",
            "Read one UTF-8 text file inside the sandbox.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        ),
    ];
    if vision {
        definitions.push(tool_def(
            "fs.list_image_files",
            "List supported PNG, JPEG, and WebP images inside the sandbox.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "dir": { "type": "string", "default": "." },
                    "maxDepth": { "type": "integer", "default": 3 }
                },
                "additionalProperties": false
            }),
        ));
        definitions.push(tool_def(
            "fs.read_image",
            "Read one sandbox image so it can be viewed.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        ));
    }
    if web_search_enabled {
        definitions.push(tool_def(
            "web.search",
            "Search the public web for current, recent, or externally verifiable information. Use it only when web information would materially improve the answer.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "A focused web search query."
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
        ));
    }
    definitions
}

#[derive(Debug)]
pub struct ToolExecutionResult {
    pub content: Value,
    pub attachments: Vec<InferenceAttachment>,
}

#[allow(dead_code)]
pub fn execute_tool(
    tool: &str,
    args: &Value,
    session_id: &str,
    sandbox: &Sandbox,
    config: &ToolHostConfig,
) -> Result<ToolExecutionResult, AgentError> {
    execute_tool_with_tavily(tool, args, session_id, sandbox, config, None)
}

pub fn execute_tool_with_tavily(
    tool: &str,
    args: &Value,
    session_id: &str,
    sandbox: &Sandbox,
    config: &ToolHostConfig,
    tavily: Option<&mut TavilyRoundWrapper<'_>>,
) -> Result<ToolExecutionResult, AgentError> {
    let cancel = TurnCancellation::default();
    execute_tool_cancellable(tool, args, session_id, sandbox, config, tavily, &cancel)
}

/// Helper processes end as soon as `cancel` fires. In-process tools are short,
/// and web search is bounded by its request timeout, so those run to their end.
pub fn execute_tool_cancellable(
    tool: &str,
    args: &Value,
    _session_id: &str,
    sandbox: &Sandbox,
    config: &ToolHostConfig,
    tavily: Option<&mut TavilyRoundWrapper<'_>>,
    cancel: &TurnCancellation,
) -> Result<ToolExecutionResult, AgentError> {
    match tool {
        "fs.list_text_files" => {
            let dir = args.get("dir").and_then(Value::as_str).unwrap_or(".");
            let max_depth = args
                .get("maxDepth")
                .and_then(Value::as_u64)
                .unwrap_or(3)
                .min(16) as usize;
            let files = sandbox.list_text_files(dir, max_depth)?;
            Ok(ToolExecutionResult {
                content: serde_json::json!({ "files": files }),
                attachments: vec![],
            })
        }
        "fs.read_text_file" => {
            let path = args.get("path").and_then(Value::as_str).ok_or_else(|| {
                AgentError::new("INVALID_ARGUMENT", "fs.read_text_file requires path")
            })?;
            let (text, truncated) = sandbox.read_text_file(path)?;
            Ok(ToolExecutionResult {
                content: serde_json::json!({ "path": path, "text": text, "truncated": truncated }),
                attachments: vec![],
            })
        }
        "fs.list_image_files" => {
            let dir = args.get("dir").and_then(Value::as_str).unwrap_or(".");
            let depth = args
                .get("maxDepth")
                .and_then(Value::as_u64)
                .unwrap_or(3)
                .min(16) as usize;
            let (files, truncated) = sandbox.list_image_files(dir, depth)?;
            Ok(ToolExecutionResult {
                content: serde_json::json!({"files":files,"truncated":truncated}),
                attachments: vec![],
            })
        }
        "fs.read_image" => {
            let path = args.get("path").and_then(Value::as_str).ok_or_else(|| {
                AgentError::new("INVALID_ARGUMENT", "fs.read_image requires path")
            })?;
            let (info, bytes) = sandbox.read_image(path)?;
            Ok(ToolExecutionResult {
                content: serde_json::to_value(&info).unwrap(),
                attachments: vec![InferenceAttachment {
                    media_type: info.media_type,
                    bytes,
                }],
            })
        }
        "bash" => Ok(ToolExecutionResult {
            content: bash_tool(args, config, cancel)?,
            attachments: vec![],
        }),
        "web.search" => {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .ok_or_else(|| AgentError::new("INVALID_ARGUMENT", "web.search requires query"))?;
            let content = tavily
                .ok_or_else(|| {
                    AgentError::new("WEB_SEARCH_UNAVAILABLE", "Web search is not configured.")
                })?
                .search(query)?;
            Ok(ToolExecutionResult {
                content,
                attachments: vec![],
            })
        }
        _ => Err(AgentError::with_details(
            "INVALID_ARGUMENT",
            "Unknown tool",
            serde_json::json!({ "tool": tool }),
        )),
    }
}

fn bash_tool(
    args: &Value,
    config: &ToolHostConfig,
    cancel: &TurnCancellation,
) -> Result<Value, AgentError> {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| AgentError::new("INVALID_ARGUMENT", "bash requires command"))?;
    let requested_timeout_ms = args.get("timeoutMs").and_then(Value::as_u64);
    let stdin = match args.get("stdin") {
        None => None,
        Some(Value::String(value)) => Some(value.as_str()),
        Some(_) => {
            return Err(AgentError::new(
                "INVALID_ARGUMENT",
                "bash stdin must be a string when provided.",
            ));
        }
    };
    let argv = parse_restricted_bash_command(command)?;
    validate_pedelec_cli_command(&argv)?;
    let wants_stdin = argv.get(6).map(String::as_str) == Some("--stdin-field");
    // Models often fill optional fields with "", which carries nothing to lose.
    let stdin = stdin.filter(|text| wants_stdin || !text.is_empty());
    if wants_stdin != stdin.is_some() {
        return Err(AgentError::new(
            "INVALID_ARGUMENT",
            "stdin needs the tool-call command to end with `--stdin-field <argument-name>`, and that flag needs stdin.",
        ));
    }
    // Ending the CLI early turns a running Host Tool into an unknown outcome, so a model may only extend this.
    let timeout_ms = requested_timeout_ms
        .unwrap_or(config.pedelec_cli_timeout_ms)
        .max(config.pedelec_cli_timeout_ms);
    let cli_path = resolve_pedelec_cli(config)?;
    let mut process = Command::new(cli_path);
    process
        .args(&argv[1..])
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(runtime_file) = &config.core_runtime_file {
        process.env("PEDELEC_CORE_IPC_RUNTIME_FILE", runtime_file);
    }
    run_pedelec_cli_command(process, timeout_ms, stdin, cancel)
}

fn parse_restricted_bash_command(command: &str) -> Result<Vec<String>, AgentError> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(AgentError::new(
            "INVALID_ARGUMENT",
            "command must be a non-empty restricted Pedelec helper command.",
        ));
    }

    let mut args = Vec::new();
    let mut current = String::new();
    let mut chars = trimmed.chars().peekable();
    let mut quote: Option<char> = None;
    let mut token_started = false;

    while let Some(ch) = chars.next() {
        match quote {
            Some(quote_char) => {
                if ch == quote_char {
                    quote = None;
                } else if quote_char == '"' && ch == '$' {
                    return Err(unsupported_shell_syntax(
                        "environment variable expansion is not supported.",
                    ));
                } else {
                    current.push(ch);
                }
            }
            None => match ch {
                '\'' | '"' => {
                    quote = Some(ch);
                    token_started = true;
                }
                ch if ch.is_whitespace() => {
                    if token_started {
                        args.push(std::mem::take(&mut current));
                        token_started = false;
                    }
                    while chars.peek().is_some_and(|value| value.is_whitespace()) {
                        chars.next();
                    }
                }
                '|' | '>' | '<' | ';' | '&' => {
                    return Err(unsupported_shell_syntax(
                        "pipes, redirects, command chaining, and background commands are not supported.",
                    ));
                }
                '$' => {
                    return Err(unsupported_shell_syntax(
                        "environment variable expansion and command substitution are not supported.",
                    ));
                }
                _ => {
                    token_started = true;
                    current.push(ch);
                }
            },
        }
    }

    if let Some(quote_char) = quote {
        return Err(AgentError::with_details(
            "INVALID_ARGUMENT",
            "command contains an unterminated quote.",
            serde_json::json!({ "quote": quote_char }),
        ));
    }
    if token_started {
        args.push(current);
    }
    if args.is_empty() {
        return Err(AgentError::new(
            "INVALID_ARGUMENT",
            "command must be a non-empty restricted Pedelec helper command.",
        ));
    }
    Ok(args)
}

fn unsupported_shell_syntax(message: &str) -> AgentError {
    AgentError::new(
        "UNSUPPORTED_SHELL_SYNTAX",
        format!(
            "{message} Use only restricted Pedelec helpers: pedelec-cli --thread-id <pedelec_thread_id> tool-spec <tool_name> or pedelec-cli --thread-id <pedelec_thread_id> tool-call <tool_name> ..."
        ),
    )
}

fn validate_pedelec_cli_command(argv: &[String]) -> Result<(), AgentError> {
    if argv.first().map(String::as_str) != Some("pedelec-cli") {
        return Err(AgentError::with_details(
            "COMMAND_NOT_ALLOWED",
            "Only restricted Pedelec helper commands are allowed; use pedelec-cli for App Tools.",
            serde_json::json!({ "allowed": [
                "pedelec-cli --thread-id <pedelec_thread_id> tool-spec <tool_name>",
                "pedelec-cli --thread-id <pedelec_thread_id> tool-call <tool_name> ..."
            ] }),
        ));
    }

    if argv.get(1).map(String::as_str) != Some("--thread-id") {
        return Err(AgentError::new(
            "INVALID_ARGUMENT",
            "usage: pedelec-cli --thread-id <pedelec_thread_id> tool-spec <tool_name> OR pedelec-cli --thread-id <pedelec_thread_id> tool-call <tool_name> ...",
        ));
    }
    if argv
        .get(2)
        .map(String::as_str)
        .is_none_or(|thread_id| thread_id.trim().is_empty())
    {
        return Err(AgentError::new(
            "INVALID_ARGUMENT",
            "pedelec-cli requires a non-empty --thread-id value.",
        ));
    }

    match argv.get(3).map(String::as_str) {
        Some("tool-spec") if argv.len() == 5 && !argv[4].trim().is_empty() => Ok(()),
        Some("tool-spec") => Err(AgentError::new(
            "INVALID_ARGUMENT",
            "usage: pedelec-cli --thread-id <pedelec_thread_id> tool-spec <tool_name>",
        )),
        Some("tool-call") if argv.len() >= 5 && !argv[4].trim().is_empty() => Ok(()),
        Some("tool-call") => Err(AgentError::new(
            "INVALID_ARGUMENT",
            "usage: pedelec-cli --thread-id <pedelec_thread_id> tool-call <tool_name> ...",
        )),
        _ => Err(AgentError::with_details(
            "COMMAND_NOT_ALLOWED",
            "Only pedelec-cli App Tool commands are allowed.",
            serde_json::json!({ "command": argv }),
        )),
    }
}

fn run_pedelec_cli_command(
    mut command: Command,
    timeout_ms: u64,
    stdin: Option<&str>,
    cancel: &TurnCancellation,
) -> Result<Value, AgentError> {
    let timed_output =
        run_command_with_timeout(&mut command, timeout_ms, stdin, cancel).map_err(|err| {
            AgentError::with_details(
                "PEDELEC_CLI_FAILED",
                "Failed to execute pedelec-cli",
                serde_json::json!({ "error": err.to_string() }),
            )
        })?;
    if timed_output.cancelled {
        return Err(interrupted_error());
    }
    let output = timed_output.output;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if timed_output.timed_out {
        return Err(AgentError::with_details(
            "PEDELEC_CLI_TIMEOUT",
            "pedelec-cli timed out.",
            serde_json::json!({
                "timeoutMs": timeout_ms,
                "stdout": stdout,
                "stderr": stderr
            }),
        ));
    }
    if !output.status.success() {
        return Err(AgentError::with_details(
            "PEDELEC_CLI_FAILED",
            "pedelec-cli exited with an error",
            serde_json::json!({
                "status": output.status.code(),
                "stdout": stdout,
                "stderr": stderr
            }),
        ));
    }
    serde_json::from_str::<Value>(&stdout).map_err(|err| {
        AgentError::with_details(
            "PEDELEC_CLI_FAILED",
            "pedelec-cli stdout was not valid JSON",
            serde_json::json!({ "stdout": stdout, "error": err.to_string() }),
        )
    })
}

struct TimedOutput {
    output: Output,
    timed_out: bool,
    cancelled: bool,
}

/// Gives the helper its own process group, so a cancel can end anything it
/// started as well.
#[cfg(unix)]
fn isolate_helper_process_tree(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn isolate_helper_process_tree(_command: &mut Command) {}

#[cfg(unix)]
fn kill_helper_process_tree(child: &mut Child) {
    // The group leader is unreaped until `wait_with_output`, so the PGID still
    // belongs to this helper.
    if unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) } == -1 {
        let _ = child.kill();
    }
}

#[cfg(windows)]
fn kill_helper_process_tree(child: &mut Child) {
    let killed_tree = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if !killed_tree {
        let _ = child.kill();
    }
}

fn run_command_with_timeout(
    command: &mut Command,
    timeout_ms: u64,
    stdin: Option<&str>,
    cancel: &TurnCancellation,
) -> Result<TimedOutput, io::Error> {
    isolate_helper_process_tree(command);
    let mut child = command.spawn()?;
    let stdin_writer = match spawn_stdin_writer(&mut child, stdin) {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };

    let wait_result = wait_spawned_child_with_timeout(child, timeout_ms, cancel);
    match wait_result {
        Ok(timed) if timed.timed_out || timed.cancelled => {
            let _ = join_stdin_writer(stdin_writer);
            Ok(timed)
        }
        Ok(timed) => match join_stdin_writer(stdin_writer) {
            Ok(()) => Ok(timed),
            Err(error) => Err(error),
        },
        Err(error) => {
            let _ = join_stdin_writer(stdin_writer);
            Err(error)
        }
    }
}

fn spawn_stdin_writer(
    child: &mut Child,
    stdin: Option<&str>,
) -> Result<Option<JoinHandle<io::Result<()>>>, io::Error> {
    let Some(input) = stdin else {
        return Ok(None);
    };
    let mut child_stdin = child.stdin.take().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::BrokenPipe,
            "restricted helper stdin was not piped",
        )
    })?;
    let input = input.to_owned();
    Ok(Some(thread::spawn(move || {
        let result = child_stdin
            .write_all(input.as_bytes())
            .and_then(|_| child_stdin.flush())
            .map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("could not write restricted helper stdin: {error}"),
                )
            });
        drop(child_stdin);
        result
    })))
}

fn join_stdin_writer(stdin_writer: Option<JoinHandle<io::Result<()>>>) -> io::Result<()> {
    let Some(handle) = stdin_writer else {
        return Ok(());
    };
    match handle.join() {
        Ok(result) => result,
        Err(_) => Err(io::Error::new(
            io::ErrorKind::Other,
            "restricted helper stdin writer panicked",
        )),
    }
}

fn wait_spawned_child_with_timeout(
    mut child: Child,
    timeout_ms: u64,
    cancel: &TurnCancellation,
) -> Result<TimedOutput, io::Error> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1));
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child.wait_with_output().map(|output| TimedOutput {
                    output,
                    timed_out: false,
                    cancelled: false,
                });
            }
            Ok(None) if cancel.is_cancelled() => {
                kill_helper_process_tree(&mut child);
                return child.wait_with_output().map(|output| TimedOutput {
                    output,
                    timed_out: false,
                    cancelled: true,
                });
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                return child.wait_with_output().map(|output| TimedOutput {
                    output,
                    timed_out: true,
                    cancelled: false,
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
    }
}

fn resolve_pedelec_cli(config: &ToolHostConfig) -> Result<PathBuf, AgentError> {
    if let Some(path) = &config.pedelec_cli_path {
        if path.exists() {
            return Ok(path.clone());
        }
    }
    find_on_path("pedelec-cli")
        .ok_or_else(|| AgentError::new("PEDELEC_CLI_NOT_FOUND", "Cannot find pedelec-cli."))
}

fn find_on_path(program: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        for candidate in candidates(&dir, program) {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn candidates(dir: &Path, program: &str) -> Vec<PathBuf> {
    let mut values = vec![dir.join(program)];
    #[cfg(windows)]
    {
        values.push(dir.join(format!("{program}.exe")));
        values.push(dir.join(format!("{program}.cmd")));
        values.push(dir.join(format!("{program}.bat")));
    }
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const PIPE_OVERFLOW_STDIN_LEN: usize = 256 * 1024;
    const STDIN_CALL: &str =
        "pedelec-cli --thread-id thread_explicit tool-call write '{\"path\":\"a.ts\"}' --stdin-field content";

    fn config() -> ToolHostConfig {
        ToolHostConfig {
            pedelec_cli_path: None,
            core_runtime_file: None,
            // A parallel test's child can hold a pipe open briefly; only timeout tests set a short budget.
            pedelec_cli_timeout_ms: 10_000,
        }
    }

    #[test]
    fn filesystem_tool_works_without_host_routing_config() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("README.md"), "hello").unwrap();
        let sandbox = Sandbox::new(temp.path(), 1024, 20 * 1024 * 1024, 200).unwrap();
        let cfg = config();

        let result = execute_tool(
            "fs.read_text_file",
            &serde_json::json!({ "path": "README.md" }),
            "session_inner",
            &sandbox,
            &cfg,
        )
        .unwrap();

        assert_eq!(result.content["text"], "hello");
    }

    #[test]
    fn tool_definitions_expose_bash_not_old_native_host_tools() {
        let tools = agent_tool_definitions(false, false);
        let names = tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"bash"));
        assert!(!names
            .iter()
            .any(|name| name.contains("pedelec_cli.tool_spec")));
        assert!(!names
            .iter()
            .any(|name| name.contains("pedelec_cli.tool_call")));
        let bash = tools.iter().find(|tool| tool.name == "bash").unwrap();
        assert!(bash
            .description
            .contains("restricted Pedelec helper command"));
        assert!(bash.description.contains("pedelec-cli"));
        assert!(!bash.description.contains("pedelec-ts-runtime"));
        assert!(bash.description.contains("--stdin-field"));
        assert!(bash.description.contains("not a full shell"));
        assert_eq!(bash.input_schema["properties"]["stdin"]["type"], "string");
        assert_eq!(
            bash.input_schema["required"],
            serde_json::json!(["command"])
        );
        assert!(tools.iter().all(|tool| tool.input_schema.is_object()));
    }

    #[test]
    fn web_search_definition_is_conditional_and_only_accepts_query() {
        assert!(!agent_tool_definitions(false, false)
            .iter()
            .any(|tool| tool.name == "web.search"));
        let tools = agent_tool_definitions(false, true);
        let web = tools.iter().find(|tool| tool.name == "web.search").unwrap();
        assert_eq!(web.input_schema["required"], serde_json::json!(["query"]));
        assert!(web.input_schema["properties"].get("max_results").is_none());
    }

    #[test]
    fn bash_tool_does_not_pass_session_id_to_pedelec_cli() {
        let temp = tempfile::tempdir().unwrap();
        let capture = temp.path().join("args.txt");
        let cli = fake_pedelec_cli(temp.path(), &capture);
        let sandbox = Sandbox::new(temp.path(), 1024, 20 * 1024 * 1024, 200).unwrap();
        let mut cfg = config();
        cfg.pedelec_cli_path = Some(cli);

        let result = execute_tool(
            "bash",
            &serde_json::json!({
                "command": "pedelec-cli --thread-id thread_explicit tool-call get_page '{\"id\":1}'"
            }),
            "session_inner",
            &sandbox,
            &cfg,
        )
        .unwrap();

        assert_eq!(result.content["ok"], true);
        let args = std::fs::read_to_string(capture).unwrap();
        assert!(args.contains("tool-call"));
        assert!(args.contains("--thread-id"));
        assert!(args.contains("thread_explicit"));
        assert!(args.contains("get_page"));
        assert!(args.contains("id"));
        assert!(args.contains("1"));
        assert!(!args.contains("session_inner"));
    }

    #[test]
    fn bash_tool_delivers_stdin_only_with_the_stdin_field_flag() {
        let temp = tempfile::tempdir().unwrap();
        let capture = temp.path().join("args.txt");
        let sandbox = Sandbox::new(temp.path(), 1024, 20 * 1024 * 1024, 200).unwrap();
        let mut cfg = config();
        cfg.pedelec_cli_path = Some(fake_pedelec_cli(temp.path(), &capture));
        let source = "import x from 'node:fs';\nconsole.log(\"$HOME\");\n";

        let result = execute_tool(
            "bash",
            &serde_json::json!({ "command": STDIN_CALL, "stdin": source }),
            "session_inner",
            &sandbox,
            &cfg,
        )
        .unwrap();
        assert_eq!(result.content["ok"], true);
        assert!(std::fs::read_to_string(&capture)
            .unwrap()
            .contains("--stdin-field content"));
        assert_eq!(
            std::fs::read_to_string(capture.with_extension("stdin")).unwrap(),
            source
        );

        let empty =
            serde_json::json!({ "command": "pedelec-cli --thread-id t tool-spec x", "stdin": "" });
        assert!(execute_tool("bash", &empty, "session_inner", &sandbox, &cfg).is_ok());

        for args in [
            serde_json::json!({ "command": STDIN_CALL }),
            serde_json::json!({ "command": "pedelec-cli --thread-id t tool-spec x", "stdin": "nope" }),
        ] {
            let error = execute_tool("bash", &args, "session_inner", &sandbox, &cfg).unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT");
        }
    }

    #[test]
    fn bash_tool_refuses_a_timeout_below_the_host_budget() {
        let temp = tempfile::tempdir().unwrap();
        let sandbox = Sandbox::new(temp.path(), 1024, 20 * 1024 * 1024, 200).unwrap();
        let mut cfg = config();
        cfg.pedelec_cli_path = Some(fake_sleeping_pedelec_cli(temp.path()));
        cfg.pedelec_cli_timeout_ms = 300;

        let error = execute_tool(
            "bash",
            &serde_json::json!({
                "command": "pedelec-cli --thread-id t tool-call slow '{}'",
                "timeoutMs": 1
            }),
            "session_inner",
            &sandbox,
            &cfg,
        )
        .unwrap_err();

        assert_eq!(error.code, "PEDELEC_CLI_TIMEOUT");
        assert_eq!(error.details.unwrap()["timeoutMs"], 300);
    }

    #[test]
    fn bash_tool_stdin_write_does_not_bypass_timeout() {
        let temp = tempfile::tempdir().unwrap();
        let cli = fake_sleeping_pedelec_cli(temp.path());
        let sandbox = Sandbox::new(temp.path(), 1024, 20 * 1024 * 1024, 200).unwrap();
        let mut cfg = config();
        cfg.pedelec_cli_path = Some(cli);
        cfg.pedelec_cli_timeout_ms = 300;
        let started = Instant::now();

        let error = execute_tool(
            "bash",
            &serde_json::json!({
                "command": STDIN_CALL,
                "timeoutMs": 300,
                "stdin": "X".repeat(PIPE_OVERFLOW_STDIN_LEN)
            }),
            "session_inner",
            &sandbox,
            &cfg,
        )
        .unwrap_err();

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "blocked stdin write bypassed the helper timeout: {:?}",
            started.elapsed()
        );
        assert_eq!(error.code, "PEDELEC_CLI_TIMEOUT");
        assert!(error.message.contains("timed out"));
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("timeoutMs")),
            Some(&serde_json::json!(300))
        );
    }

    #[test]
    fn bash_tool_without_stdin_still_times_out() {
        let temp = tempfile::tempdir().unwrap();
        let cli = fake_sleeping_pedelec_cli(temp.path());
        let sandbox = Sandbox::new(temp.path(), 1024, 20 * 1024 * 1024, 200).unwrap();
        let mut cfg = config();
        cfg.pedelec_cli_path = Some(cli);
        cfg.pedelec_cli_timeout_ms = 300;
        let started = Instant::now();

        let error = execute_tool(
            "bash",
            &serde_json::json!({
                "command": "pedelec-cli --thread-id thread_explicit tool-call slow '{}'",
                "timeoutMs": 300
            }),
            "session_inner",
            &sandbox,
            &cfg,
        )
        .unwrap_err();

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "command without stdin bypassed the helper timeout: {:?}",
            started.elapsed()
        );
        assert_eq!(error.code, "PEDELEC_CLI_TIMEOUT");
        assert!(error.message.contains("timed out"));
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("timeoutMs")),
            Some(&serde_json::json!(300))
        );
    }

    #[test]
    fn bash_tool_surfaces_stdin_write_failure() {
        let temp = tempfile::tempdir().unwrap();
        let cli = fake_closed_stdin_pedelec_cli(temp.path());
        let sandbox = Sandbox::new(temp.path(), 1024, 20 * 1024 * 1024, 200).unwrap();
        let mut cfg = config();
        cfg.pedelec_cli_path = Some(cli);

        let error = execute_tool(
            "bash",
            &serde_json::json!({
                "command": STDIN_CALL,
                "stdin": "X".repeat(PIPE_OVERFLOW_STDIN_LEN)
            }),
            "session_inner",
            &sandbox,
            &cfg,
        )
        .unwrap_err();

        assert_eq!(error.code, "PEDELEC_CLI_FAILED");
        let details = error
            .details
            .as_ref()
            .and_then(|details| details.get("error"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(
            details.contains("could not write restricted helper stdin"),
            "write failure was not surfaced with useful context: {error:?}"
        );
    }

    fn bash_tool_rejects_non_pedelec_helper_commands() {
        let temp = tempfile::tempdir().unwrap();
        let sandbox = Sandbox::new(temp.path(), 1024, 20 * 1024 * 1024, 200).unwrap();
        let cfg = config();

        let err = execute_tool(
            "bash",
            &serde_json::json!({ "command": "ls" }),
            "session_inner",
            &sandbox,
            &cfg,
        )
        .unwrap_err();

        assert_eq!(err.code, "COMMAND_NOT_ALLOWED");
    }

    #[test]
    fn bash_tool_rejects_unsupported_shell_syntax() {
        let temp = tempfile::tempdir().unwrap();
        let sandbox = Sandbox::new(temp.path(), 1024, 20 * 1024 * 1024, 200).unwrap();
        let cfg = config();

        let err = execute_tool(
            "bash",
            &serde_json::json!({ "command": "pedelec-cli --thread-id thread_inner tool-spec foo && rm -rf /" }),
            "session_inner",
            &sandbox,
            &cfg,
        )
        .unwrap_err();

        assert_eq!(err.code, "UNSUPPORTED_SHELL_SYNTAX");
    }

    #[test]
    fn parses_single_and_double_quoted_arguments() {
        let single = parse_restricted_bash_command(
            "pedelec-cli --thread-id thread_1 tool-call ask_user '{\"question\":\"要繼續嗎？\"}'",
        )
        .unwrap();
        assert_eq!(
            single,
            vec![
                "pedelec-cli",
                "--thread-id",
                "thread_1",
                "tool-call",
                "ask_user",
                "{\"question\":\"要繼續嗎？\"}"
            ]
        );

        let double = parse_restricted_bash_command(
            "pedelec-cli --thread-id thread_1 tool-spec \"get current page\"",
        )
        .unwrap();
        assert_eq!(
            double,
            vec![
                "pedelec-cli",
                "--thread-id",
                "thread_1",
                "tool-spec",
                "get current page"
            ]
        );
    }

    #[test]
    fn parser_rejects_command_substitution() {
        let err = parse_restricted_bash_command(
            "pedelec-cli --thread-id thread_1 tool-spec $(cat secret)",
        )
        .unwrap_err();

        assert_eq!(err.code, "UNSUPPORTED_SHELL_SYNTAX");
    }

    #[test]
    fn restricted_command_requires_explicit_thread_id() {
        let err = validate_pedelec_cli_command(&[
            "pedelec-cli".into(),
            "tool-spec".into(),
            "get_page".into(),
        ])
        .unwrap_err();

        assert_eq!(err.code, "INVALID_ARGUMENT");
        assert!(err.message.contains("--thread-id"));

        let err = validate_pedelec_cli_command(&[
            "pedelec-cli".into(),
            "--thread-id".into(),
            "   ".into(),
            "tool-spec".into(),
            "get_page".into(),
        ])
        .unwrap_err();

        assert_eq!(err.code, "INVALID_ARGUMENT");
        assert!(err.message.contains("non-empty"));
    }

    #[test]
    fn old_native_host_tool_is_unknown() {
        let temp = tempfile::tempdir().unwrap();
        let sandbox = Sandbox::new(temp.path(), 1024, 20 * 1024 * 1024, 200).unwrap();
        let cfg = config();

        let err = execute_tool(
            "pedelec_cli.tool_call",
            &serde_json::json!({ "toolName": "get_page", "args": {} }),
            "session_inner",
            &sandbox,
            &cfg,
        )
        .unwrap_err();

        assert_eq!(err.code, "INVALID_ARGUMENT");
    }

    #[cfg(windows)]
    fn fake_pedelec_cli(dir: &Path, capture: &Path) -> PathBuf {
        let path = dir.join("pedelec-cli.cmd");
        // `more` rewrites stdin newlines on Windows (CRLF and a trailing blank line).
        // Use a binary stream copy so the test verifies the exact bytes passed to the helper.
        let stdin_path = capture.with_extension("stdin");
        let escaped_stdin_path = stdin_path.to_string_lossy().replace('\'', "''");
        std::fs::write(
            &path,
            format!(
                "@echo off\r\npowershell.exe -NoProfile -NonInteractive -Command \"$output = [System.IO.File]::Create('{}'); try {{ [Console]::OpenStandardInput().CopyTo($output) }} finally {{ $output.Dispose() }}\"\r\necho %* > \"{}\"\r\necho {{\"ok\":true}}\r\n",
                escaped_stdin_path,
                capture.to_string_lossy()
            ),
        )
        .unwrap();
        path
    }

    #[cfg(not(windows))]
    fn fake_pedelec_cli(dir: &Path, capture: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = dir.join("pedelec-cli");
        std::fs::write(
            &path,
            format!(
                "#!/bin/sh\ncat > '{}'\nprintf '%s\\n' \"$*\" > '{}'\nprintf '%s\\n' '{{\"ok\":true}}'\n",
                capture.with_extension("stdin").to_string_lossy(),
                capture.to_string_lossy()
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        path
    }

    #[cfg(windows)]
    fn fake_sleeping_pedelec_cli(dir: &Path) -> PathBuf {
        let path = dir.join("pedelec-cli.cmd");
        // Stay inside cmd.exe so child.kill() closes the pipes wait_with_output
        // is reading. A grandchild like ping would keep those handles open.
        std::fs::write(&path, "@echo off\r\n:wait\r\ngoto wait\r\n").unwrap();
        path
    }

    #[cfg(not(windows))]
    fn fake_sleeping_pedelec_cli(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = dir.join("pedelec-cli");
        std::fs::write(&path, "#!/bin/sh\nexec sleep 30\n").unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        path
    }

    #[cfg(windows)]
    fn fake_closed_stdin_pedelec_cli(dir: &Path) -> PathBuf {
        let path = dir.join("pedelec-cli.cmd");
        std::fs::write(&path, "@echo off\r\nexit /b 0\r\n").unwrap();
        path
    }

    #[cfg(not(windows))]
    fn fake_closed_stdin_pedelec_cli(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = dir.join("pedelec-cli");
        std::fs::write(&path, "#!/bin/sh\nexec <&-\nexit 0\n").unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn cancel_ends_a_running_helper_and_its_descendants() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("descendant.pid");
        let cli = temp.path().join("pedelec-cli");
        std::fs::write(
            &cli,
            format!(
                "#!/bin/sh\nsleep 30 &\nprintf '%s' \"$!\" > '{}'\nwait\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let sandbox = Sandbox::new(temp.path(), 1024, 20 * 1024 * 1024, 200).unwrap();
        let mut cfg = config();
        cfg.pedelec_cli_path = Some(cli);
        cfg.pedelec_cli_timeout_ms = 30_000;

        let cancel = Arc::new(TurnCancellation::default());
        let canceller = {
            let cancel = Arc::clone(&cancel);
            let marker = marker.clone();
            thread::spawn(move || {
                while !marker.exists() {
                    thread::sleep(Duration::from_millis(5));
                }
                thread::sleep(Duration::from_millis(20));
                cancel.cancel();
            })
        };
        let started = Instant::now();
        let error = execute_tool_cancellable(
            "bash",
            &serde_json::json!({ "command": "pedelec-cli --thread-id thread_explicit tool-call job '{}'" }),
            "session_inner",
            &sandbox,
            &cfg,
            None,
            &cancel,
        )
        .err()
        .unwrap();
        canceller.join().unwrap();
        assert_eq!(error.code, "TURN_INTERRUPTED");
        assert!(started.elapsed() < Duration::from_secs(5));

        let pid = std::fs::read_to_string(&marker).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let output = Command::new("ps")
                .args(["-o", "stat=", "-p", pid.trim()])
                .output()
                .unwrap();
            let state = String::from_utf8_lossy(&output.stdout);
            if !output.status.success() || state.trim().is_empty() || state.trim().starts_with('Z')
            {
                break;
            }
            assert!(Instant::now() < deadline, "descendant survived the cancel");
            thread::sleep(Duration::from_millis(10));
        }
    }
}
