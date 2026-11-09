#![allow(dead_code, unused_imports)]
// Compile the owned private modules without changing Agent F's routing files.
#[path = "../src/artifacts.rs"]
mod artifacts;
#[path = "../src/providers/claude.rs"]
mod claude;
#[path = "../src/providers/common.rs"]
mod common;
#[path = "../src/event_sink.rs"]
mod event_sink;
#[path = "../src/tool_trace.rs"]
mod tool_trace;
#[path = "../src/protocol.rs"]
mod protocol;
#[derive(Debug)]
struct IpcFailure {
    code: &'static str,
    message: &'static str,
}
impl IpcFailure {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

#[test]
fn claude_effort_mapping_is_explicit() {
    assert!(claude::parse_effort("default").unwrap().is_none());
    for name in ["low", "medium", "high", "xhigh", "max"] {
        assert_eq!(claude::parse_effort(name).unwrap().unwrap().as_str(), name);
    }
    assert!(claude::parse_effort("unlimited").is_err());
}
