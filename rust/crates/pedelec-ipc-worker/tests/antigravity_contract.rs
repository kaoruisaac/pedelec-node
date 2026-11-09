#![allow(dead_code, unused_imports)]
// Agent E compiles owned module without touching Agent F's provider routing.
#[path = "../src/providers/antigravity.rs"]
mod antigravity;
#[path = "../src/artifacts.rs"]
mod artifacts;
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
