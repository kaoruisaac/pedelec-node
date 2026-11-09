"""P05 deterministic wire fixture. No Host tool engine; writes only its test log."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

root = Path(sys.argv[1])
(root / "launch.json").write_text(json.dumps({"pid": os.getpid(), "args": sys.argv[2:],
    "legacyEnv": {k: os.getenv(k) for k in ["PEDELEC_THREAD_ID", "PEDELEC_WORKSPACE_PATH", "PEDELEC_CORE_IPC_RUNTIME_FILE", "PEDELEC_PROVIDER"]}}))

def emit(event):
    print(json.dumps(event), flush=True)

for i, line in enumerate(sys.stdin, 1):
    with (root / "stdin.jsonl").open("a") as log:
        log.write(line)
    text = json.loads(line)["message"]["content"]
    if "TREE" in text:
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        (root / "child.pid").write_text(str(child.pid))
    if "CRASH" in text:
        sys.exit(91)
    if "HANG" in text:
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        (root / "child.pid").write_text(str(child.pid))
        time.sleep(120)
    if "EOF_PARTIAL" in text:
        print('{"event":', end="", flush=True)
        sys.exit(92)
    if "EARLY_RESULT" not in text and i == 1:
        emit({"event": "init", "conversation_id": "ag-fake-1"})
    emit({"event": "step_update", "step_type": "agent_response", "text_delta": "哈囉", "usage": {"input_tokens": 2, "secret": "not-monitor"}})
    emit({"event": "step_update", "step_type": "tool_call", "name": "fake-tool", "artifact": "/secret/artifact"})
    if "DELAY" in text:
        time.sleep(.3)
    result = {"event": "result", "result": {"status": "ERROR" if "FAIL" in text else "SUCCESS",
        "conversation_id": "wrong-id" if "WRONG_ID" in text else "ag-fake-1",
        "response": "final", "usage": {"total_tokens": i * 3, "private": "not-monitor"},
        "error": {"message": "secret"} if "FAIL" in text else None}}
    emit(result)
    if "DUPLICATE" in text:
        emit(result)
    if "EXIT_AFTER" in text:
        sys.exit(93)
