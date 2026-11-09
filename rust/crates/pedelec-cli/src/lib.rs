//! Standalone subset of upstream Pedelec CLI/Core IPC. Never retries an ambiguous effect.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    time::Duration,
};
const LIMIT: usize = 1024 * 1024;
/// Matches the upstream hook limit; the session endpoint accepts this size too.
const MAX_HOOK_PAYLOAD_BYTES: usize = 900 * 1024;
const MAX_STDIN_FIELD_BYTES: usize = 64 * 1024;
fn error(code: &str) -> Value {
    let message = if code == "TOOL_JSON_INVALID" {
        "tool-call JSON could not be parsed; check native shell quoting"
    } else {
        code
    };
    json!({"ok":false,"error":{"code":code,"message":message}})
}
/// Puts raw stdin text into one string field, so source never travels through argv or nested quoting.
/// The request sent to the Host is an ordinary `tool_call`, which keeps its own argument limit.
fn stdin_field(args: &mut Value, field: &str, stdin: &mut impl Read) -> Result<(), &'static str> {
    if field.is_empty() || field.len() > 128 || !field.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("TOOL_ARGS_INVALID");
    }
    let object = args.as_object_mut().ok_or("TOOL_ARGS_INVALID")?;
    // Models often leave an empty placeholder; only real text may conflict.
    if object.get(field).is_some_and(|value| value != "") {
        return Err("TOOL_ARGS_INVALID");
    }
    let mut bytes = Vec::new();
    stdin
        .take((MAX_STDIN_FIELD_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "TOOL_ARGS_INVALID")?;
    if bytes.len() > MAX_STDIN_FIELD_BYTES {
        return Err("TOOL_ARGS_INVALID");
    }
    let text = String::from_utf8(bytes).map_err(|_| "TOOL_ARGS_INVALID")?;
    object.insert(field.to_string(), Value::String(text));
    Ok(())
}

fn parse(args: &[String], stdin: &mut impl Read) -> Result<Value, &'static str> {
    if args.len() < 5
        || args[1] != "--thread-id"
        || args[2].is_empty()
        || args[2].len() > 128
        || args[2].chars().any(char::is_control)
    {
        return Err("TOOL_ARGS_INVALID");
    }
    let name = &args[4];
    if name.len() > 128
        || !name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("TOOL_ARGS_INVALID");
    }
    let mut payload = json!({"threadId":args[2],"toolName":name});
    let kind = match args[3].as_str() {
        "tool-spec" if args.len() == 5 => "tool_spec",
        "tool-call"
            if (args.len() == 6 || (args.len() == 8 && args[6] == "--stdin-field"))
                && args[5].len() <= 64 * 1024 =>
        {
            let mut tool_args: Value =
                serde_json::from_str(&args[5]).map_err(|_| "TOOL_JSON_INVALID")?;
            if let Some(field) = args.get(7) {
                stdin_field(&mut tool_args, field, stdin)?;
            }
            payload["args"] = tool_args;
            "tool_call"
        }
        _ => return Err("TOOL_ARGS_INVALID"),
    };
    Ok(json!({"requestId":uuid::Uuid::new_v4().to_string(),"type":kind,"payload":payload}))
}
pub fn exchange(mut request: Value, path: &Path) -> Result<Value, &'static str> {
    if !path.is_absolute() {
        return Err("CORE_RUNTIME_UNAVAILABLE");
    }
    let meta = std::fs::symlink_metadata(path).map_err(|_| "CORE_RUNTIME_UNAVAILABLE")?;
    if !meta.is_file() || meta.len() > 4096 {
        return Err("IPC_UNAUTHORIZED");
    }
    let runtime: Value =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| "CORE_RUNTIME_UNAVAILABLE")?)
            .map_err(|_| "CORE_RUNTIME_UNAVAILABLE")?;
    if runtime["protocol"] != "pedelec-core-ipc-v1" || runtime["host"] != "127.0.0.1" {
        return Err("IPC_UNAUTHORIZED");
    }
    let port = runtime["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)
        .ok_or("IPC_UNAUTHORIZED")?;
    let addr: SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|_| "IPC_UNAUTHORIZED")?;
    if runtime["endpoint"] != addr.to_string() {
        return Err("IPC_UNAUTHORIZED");
    }
    // Bind the process's request to the current SDK-owned turn generation, never a CLI argument.
    request["generation"] = runtime["generation"].clone();
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|_| "CORE_RUNTIME_UNAVAILABLE")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(120)))
        .map_err(|_| "IPC_UNAVAILABLE")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| "IPC_UNAVAILABLE")?;
    let wire = format!("{}\n", request);
    stream
        .write_all(wire.as_bytes())
        .map_err(|_| "OUTCOME_UNKNOWN")?;
    let mut bytes = Vec::new();
    BufReader::new(stream)
        .take((LIMIT + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "OUTCOME_UNKNOWN")?;
    if bytes.len() > LIMIT || bytes.last() != Some(&b'\n') {
        return Err("OUTCOME_UNKNOWN");
    }
    let reply: Value = serde_json::from_slice(&bytes).map_err(|_| "OUTCOME_UNKNOWN")?;
    if reply["requestId"] != request["requestId"] || !reply["ok"].is_boolean() {
        return Err("OUTCOME_UNKNOWN");
    }
    Ok(reply)
}
/// Upstream `provider-artifact-hook antigravity before|after`. `before` prints the
/// allow decision only after the host recorded its snapshot, so a failure blocks the tool.
fn run_artifact_hook(
    args: &[String],
    provider: Option<&str>,
    runtime_file: Option<&Path>,
    stdin: &mut impl Read,
) -> Result<&'static str, String> {
    let stage = match (
        args.get(2).map(String::as_str),
        args.get(3).map(String::as_str),
    ) {
        (Some("antigravity"), Some(stage @ ("before" | "after"))) if args.len() == 4 => stage,
        _ => {
            return Err("usage: pedelec-cli provider-artifact-hook antigravity before|after".into())
        }
    };
    if provider != Some("antigravity") {
        return Err("provider artifact hook requires the Antigravity runtime environment".into());
    }
    let path = runtime_file.ok_or("provider artifact hook is missing its runtime file")?;
    let mut bytes = Vec::new();
    stdin
        .take((MAX_HOOK_PAYLOAD_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "provider artifact hook could not read stdin")?;
    if bytes.len() > MAX_HOOK_PAYLOAD_BYTES {
        return Err("provider artifact hook input exceeds the limit".into());
    }
    let hook: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "provider artifact hook stdin is not valid JSON")?;
    if !hook.is_object() {
        return Err("provider artifact hook stdin must contain a JSON object".into());
    }
    let reply = exchange(
        json!({
            "requestId": uuid::Uuid::new_v4().to_string(),
            "type": "provider_artifact_hook",
            "payload": {"provider": "antigravity", "stage": stage, "hookPayload": hook},
        }),
        path,
    )
    .map_err(str::to_string)?;
    if reply["ok"] != true {
        return Err(reply["error"]["code"]
            .as_str()
            .unwrap_or("IPC_UNAVAILABLE")
            .to_string());
    }
    Ok(if stage == "before" {
        r#"{"decision":"allow"}"#
    } else {
        "{}"
    })
}

fn runtime_file_from_env() -> Option<PathBuf> {
    std::env::var_os("PEDELEC_CORE_IPC_RUNTIME_FILE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn run() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) == Some("provider-artifact-hook") {
        let provider = std::env::var("PEDELEC_PROVIDER").ok();
        let result = run_artifact_hook(
            &args,
            provider.as_deref(),
            runtime_file_from_env().as_deref(),
            &mut std::io::stdin().lock(),
        );
        match result {
            Ok(body) => println!("{body}"),
            Err(message) => {
                eprintln!("pedelec-cli provider artifact hook failed: {message}");
                std::process::exit(1);
            }
        }
        return;
    }
    let mut response = parse(&args, &mut std::io::stdin().lock())
        .and_then(|request| {
            let path = runtime_file_from_env().ok_or("CORE_RUNTIME_UNAVAILABLE")?;
            exchange(request, &path)
        })
        .unwrap_or_else(error);
    if let Some(object) = response.as_object_mut() {
        object.remove("requestId");
    }
    // CLI stdout is the authoritative result, including structured failures.
    println!("{}", response);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stdin_field_keeps_source_text_intact() {
        let source = "import x from 'node:fs';\nconsole.log(\"é\");\n";
        let call = parse(
            &args(&[
                "tool-call",
                "write",
                "{\"path\":\"a.ts\"}",
                "--stdin-field",
                "content",
            ]),
            &mut source.as_bytes(),
        )
        .unwrap();
        assert_eq!(call["type"], "tool_call");
        assert_eq!(call["payload"]["args"]["path"], "a.ts");
        assert_eq!(call["payload"]["args"]["content"], source);
        let placeholder = parse(
            &args(&[
                "tool-call",
                "write",
                "{\"content\":\"\"}",
                "--stdin-field",
                "content",
            ]),
            &mut source.as_bytes(),
        )
        .unwrap();
        assert_eq!(placeholder["payload"]["args"]["content"], source);
    }

    #[test]
    fn stdin_field_rejects_conflicts_and_oversize() {
        let call = |tail: &[&str], stdin: &[u8]| parse(&args(tail), &mut &stdin[..]).unwrap_err();
        let base = ["tool-call", "write", "{\"path\":\"a\"}", "--stdin-field"];
        for tail in [
            &[
                "tool-call",
                "write",
                "{\"path\":\"a\"}",
                "--stdin-field",
                "path",
            ][..],
            &["tool-call", "write", "[]", "--stdin-field", "content"][..],
            &["tool-call", "write", "{}", "--stdin-field", "bad-name"][..],
            &["tool-call", "write", "{}", "--other", "content"][..],
            &base[..],
        ] {
            assert_eq!(call(tail, b"x"), "TOOL_ARGS_INVALID");
        }
        let long = vec![b'x'; MAX_STDIN_FIELD_BYTES + 1];
        assert_eq!(
            call(&["tool-call", "w", "{}", "--stdin-field", "content"], &long),
            "TOOL_ARGS_INVALID"
        );
        assert_eq!(
            call(
                &["tool-call", "w", "{}", "--stdin-field", "content"],
                &[0xff]
            ),
            "TOOL_ARGS_INVALID"
        );
    }

    fn args(tail: &[&str]) -> Vec<String> {
        [vec!["pedelec-cli", "--thread-id", "session"], tail.to_vec()]
            .concat()
            .into_iter()
            .map(String::from)
            .collect()
    }
    #[test]
    fn parser_rejects_invalid_inputs() {
        for input in [
            vec!["pedelec-cli".into()],
            args(&["unknown", "echo"]),
            args(&["tool-call", "echo"]),
            args(&["tool-spec", "../evil"]),
            args(&["tool-spec", "echo", "extra"]),
        ] {
            assert_eq!(parse(&input, &mut &b""[..]), Err("TOOL_ARGS_INVALID"));
        }
        assert_eq!(
            parse(&args(&["tool-call", "echo", "{"]), &mut &b""[..]),
            Err("TOOL_JSON_INVALID")
        );
    }
    #[test]
    fn upstream_command_envelopes() {
        let call = parse(&args(&["tool-call", "echo", "{\"x\":1}"]), &mut &b""[..]).unwrap();
        assert_eq!(call["type"], "tool_call");
        assert_eq!(call["payload"]["args"]["x"], 1);
        assert_eq!(
            parse(&args(&["tool-spec", "echo"]), &mut &b""[..]).unwrap()["type"],
            "tool_spec"
        );
        assert_eq!(error("X")["ok"], false);
    }
    #[test]
    fn artifact_hook_refuses_a_foreign_environment_and_bad_stage() {
        let hook = |stage: &str| -> Vec<String> {
            [
                "pedelec-cli",
                "provider-artifact-hook",
                "antigravity",
                stage,
            ]
            .map(String::from)
            .to_vec()
        };
        let path = Path::new("/nonexistent/runtime.json");
        assert!(
            run_artifact_hook(&hook("before"), None, Some(path), &mut "{}".as_bytes()).is_err()
        );
        assert!(run_artifact_hook(
            &hook("during"),
            Some("antigravity"),
            Some(path),
            &mut "{}".as_bytes()
        )
        .is_err());
        assert!(run_artifact_hook(
            &hook("after"),
            Some("antigravity"),
            None,
            &mut "{}".as_bytes()
        )
        .is_err());
        assert!(run_artifact_hook(
            &hook("after"),
            Some("antigravity"),
            Some(path),
            &mut "[]".as_bytes()
        )
        .is_err());
    }
}
