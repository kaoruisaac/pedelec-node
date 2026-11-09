#!/usr/bin/env python3
"""Fake Claude client, not Anthropic E2E evidence. Reuses the real stdio bridge."""
import json, os, subprocess, sys, time
args = sys.argv[1:]
if '--version' in args:
    print('untrusted launcher' if os.getenv('CLAUDE_TEST_MODE')=='bad-version' else '2.1.316 (Claude Code)'); sys.exit(0)
if '--help' in args:
    print('--dangerously-skip-permissions --effort --resume --input-format --output-format --include-partial-messages'); sys.exit(0)
def option(name, default=None):
    return args[args.index(name)+1] if name in args else default
def emit(value):
    print(json.dumps(value), flush=True)
if os.getenv('CLAUDE_TEST_ARGS_LOG'):
    with open(os.environ['CLAUDE_TEST_ARGS_LOG'], 'w') as f:
        json.dump(args, f)
if os.getenv('CLAUDE_TEST_PID_LOG'):
    with open(os.environ['CLAUDE_TEST_PID_LOG'],'a') as f: f.write(str(os.getpid())+'\n')
sid = option('--resume', 'fake-claude-session')
mode = os.getenv('CLAUDE_TEST_MODE', '')
if mode == 'resume-mismatch': sid = 'different-session'
config = json.loads(option('--mcp-config', '{"mcpServers":{}}'))
mcp = None
if config['mcpServers']:
    s = config['mcpServers']['pedelec-private']
    mcp = subprocess.Popen([s['command'], *s['args']], env={**os.environ, **s['env']}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    if os.getenv('CLAUDE_TEST_PID_LOG'):
        with open(os.environ['CLAUDE_TEST_PID_LOG'],'a') as f: f.write(str(mcp.pid)+'\n')
    def rpc(id, method, params=None):
        mcp.stdin.write(json.dumps(dict(jsonrpc='2.0', id=id, method=method, params=params or {}))+'\n'); mcp.stdin.flush()
        return json.loads(mcp.stdout.readline())
    if mode == 'discovery-probe':
        rpc('discover-probe', 'server/discover')
    rpc(1, 'initialize', dict(protocolVersion='2025-06-18', capabilities={}, clientInfo=dict(name='fake',version='1')))
    mcp.stdin.write(json.dumps(dict(jsonrpc='2.0', method='notifications/initialized'))+'\n'); mcp.stdin.flush()
    tools = rpc(2, 'tools/list')['result']['tools']
for line in sys.stdin:
    user = json.loads(line)['message']['content']
    prepare = '[Session Preparation]' in user
    emit(dict(type='system', subtype='init', session_id=sid))
    if prepare:
        emit(dict(type='assistant', message=dict(content=[dict(type='text', text='PREPARE-PRIVATE')])) )
        emit(dict(type='result', subtype='error' if mode=='prepare-failure' else 'success', is_error=mode=='prepare-failure', session_id=sid))
        continue
    if mode == 'crash': sys.exit(91)
    if mode == 'malformed': print('{bad', flush=True); continue
    if mode == 'cancel': time.sleep(3)
    if mode == 'drift':
        emit(dict(type='system', subtype='init', session_id='changed')); continue
    if mcp:
        for n,t in enumerate(tools):
            r = rpc(10+n, 'tools/call', dict(name=t['name'], arguments=dict(value=t['name'])))
            if 'error' in r: sys.exit(92)
            if mode == 'handler-failure' and not r['result']['isError']: sys.exit(93)
        if mode == 'duplicate-tool':
            rpc(10, 'tools/call', dict(name=tools[0]['name'],arguments=dict(value='alpha')))
    if os.environ.get('FAKE_CLAUDE_TRACE') == '1':
        # Level 1 tool trace: a native Bash call and its result, as Claude Code stream-json reports them.
        emit(dict(type='assistant', parent_tool_use_id=None, message=dict(content=[dict(type='tool_use', id='toolu_fixture', name='Bash', input=dict(command='echo trace-ok'))])))
        emit(dict(type='user', parent_tool_use_id=None, message=dict(content=[dict(type='tool_result', tool_use_id='toolu_fixture', content='trace-ok', is_error=False)]), tool_use_result=dict(stdout='trace-ok', stderr='', interrupted=False)))
    emit(dict(type='stream_event', event=dict(type='content_block_delta',delta=dict(type='text_delta',text='hello'))))
    emit(dict(type='assistant',message=dict(content=[dict(type='text',text='hello')])) )
    if mode == 'duplicate-final':
        emit(dict(type='assistant',message=dict(content=[dict(type='text',text='hello')])) )
    emit(dict(type='result',subtype='error' if mode=='failed' else 'success',is_error=mode=='failed',session_id=sid,usage=dict(input_tokens=3,output_tokens=2)))
    if mode == 'late':
        emit(dict(type='assistant',message=dict(content=[dict(type='text',text='LATE-PRIVATE')])) )
