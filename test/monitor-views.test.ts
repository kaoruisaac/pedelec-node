import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPedelecRuntime, defineTool, type PedelecMonitorEvent } from '../src/index.ts';
import { fakeTransport, waitFor } from './fake-transport.ts';

const tool = defineTool({ name: 'note', description: 'Store a note', argsSchema: { type: 'object' } });

let storage: string;
beforeEach(() => { storage = realpathSync(mkdtempSync(join(tmpdir(), 'pedelec-monitor-'))); });
afterEach(() => rmSync(storage, { recursive: true, force: true }));

describe('Monitor two-source contract', () => {
  it('records SDK callback data separately from real incoming transport payloads', async () => {
    const transport = fakeTransport();
    const sdk = await createPedelecRuntime({ transport, detailedMonitoring: true });
    const observed: PedelecMonitorEvent[] = [];
    sdk.onMonitorEvent((event) => { observed.push(event); });
    const session = await sdk.createSession({ provider: 'codex', model: 'test', effort: 'default', workdir: '/srv/test', runtimeStorageRoot: join(storage, 'runtime'), tools: [tool] });
    const callbacks: string[] = [];
    session.onChatDelta((text) => { callbacks.push('delta:' + text); });
    session.onChat((text) => { callbacks.push('chat:' + text); });
    session.onStatus((status) => { callbacks.push('status:' + status); });
    session.onTurnEnded((outcome) => { callbacks.push('ended:' + outcome.terminal); });
    session.onTool('note', (args) => ({ success: true, result: { received: args } }));
    await session.sendText('Please write a note.', { turnId: 'turn-a' });
    const connection = transport.connections[0]!;
    connection.push('turn', { type: 'assistant-delta', text: 'Hello' });
    connection.push('turn', { type: 'assistant-message', text: 'Hello world' });
    connection.push('tool-request', { turnId: 'turn-a', toolCallId: 'call-a', toolName: 'note', args: { title: 'test note' } });
    await waitFor(() => connection.count('toolReply') === 1);
    connection.push('terminal', { turnId: 'turn-a', status: 'completed' });
    await waitFor(() => session.getStatus() === 'idle');
    expect(callbacks).toContain('delta:Hello');
    expect(callbacks).toContain('chat:Hello world');
    expect(callbacks).toContain('ended:completed');
    const sdkEvent = (kind: string) => observed.find((event) => event.kind === kind);
    expect(sdkEvent('sdk.onChatDelta')?.data).toMatchObject({ text: 'Hello', listenerCount: 1 });
    expect(sdkEvent('sdk.onChat')?.data).toMatchObject({ text: 'Hello world', listenerCount: 1 });
    expect(sdkEvent('sdk.onTool')?.data).toMatchObject({ args: { title: 'test note' } });
    expect(sdkEvent('sdk.onTool.result')?.data).toMatchObject({ reply: { success: true, result: { received: { title: 'test note' } } } });
    expect(sdkEvent('sdk.onStatus')?.data).toMatchObject({ status: 'busy', listenerCount: 1 });
    expect(sdkEvent('sdk.onTurnEnded')?.data).toMatchObject({ outcome: { terminal: 'completed' }, listenerCount: 1 });
    const transportEvent = observed.find((event) => event.kind === 'transport.event' && (event.data as any)?.data?.type === 'assistant-message');
    expect(transportEvent?.data).toMatchObject({ kind: 'turn', data: { text: 'Hello world' } });
    expect(observed.find((event) => event.kind === 'turn.assistant-message')?.data).not.toHaveProperty('text');
    await sdk.close();
  });
  it('observes onChatDelta without a Host listener, without falsely claiming delivery', async () => {
    const transport = fakeTransport();
    const sdk = await createPedelecRuntime({ transport, detailedMonitoring: true });
    const events: PedelecMonitorEvent[] = [];
    sdk.onMonitorEvent((event) => { events.push(event); });
    const session = await sdk.createSession({ provider: 'codex', model: 'test', effort: 'default', workdir: '/srv/test', runtimeStorageRoot: join(storage, 'runtime'), tools: [] });
    await session.sendText('hello', { turnId: 'turn-no-delta-subscriber' });
    const connection = transport.connections[0]!;
    connection.push('turn', { type: 'assistant-delta', text: 'streamed part' });
    connection.push('turn', { type: 'assistant-message', text: 'streamed part' });
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => session.getStatus() === 'idle');
    expect(events.find((event) => event.kind === 'sdk.onChatDelta')?.data).toMatchObject({
      text: 'streamed part', listenerCount: 0,
    });
    expect(events.find((event) => event.kind === 'sdk.onChat')?.data).toMatchObject({
      text: 'streamed part', listenerCount: 0,
    });
    await sdk.close();
  });

  it('records onChat, onStatus, onTurnEnded and onEnded with zero Host subscribers', async () => {
    const transport = fakeTransport();
    const sdk = await createPedelecRuntime({ transport, detailedMonitoring: true });
    const events: PedelecMonitorEvent[] = [];
    sdk.onMonitorEvent((event) => { events.push(event); });
    const session = await sdk.createSession({ provider: 'codex', model: 'test', effort: 'default', workdir: '/srv/test', runtimeStorageRoot: join(storage, 'runtime'), tools: [] });
    await session.sendText('hello', { turnId: 'turn-b' });
    const connection = transport.connections[0]!;
    connection.push('turn', { type: 'assistant-message', text: 'Done' });
    connection.push('terminal', { turnId: 'turn-b', status: 'completed' });
    await waitFor(() => session.getStatus() === 'idle');
    const seen = (kind: string) => events.find((event) => event.kind === kind);
    expect(seen('sdk.onChat')?.data).toMatchObject({ text: 'Done', listenerCount: 0 });
    expect(seen('sdk.onTurnEnded')?.data).toMatchObject({ outcome: { terminal: 'completed' }, listenerCount: 0 });
    expect(events.filter((event) => event.kind === 'sdk.onStatus').map((event) => (event.data as any).status))
      .toEqual(['busy', 'idle']);
    expect(events.filter((event) => event.kind === 'sdk.onStatus').every((event) => (event.data as any).listenerCount === 0)).toBe(true);
    // The Provider sent no delta: never invent a corresponding SDK event.
    expect(seen('sdk.onChatDelta')).toBeUndefined();
    expect(events.find((event) => event.kind === 'transport.event' && (event.data as any)?.data?.text === 'Done')).toBeDefined();
    await session.close('done');
    expect(seen('sdk.onEnded')?.data).toMatchObject({ reason: { reason: 'closed' }, listenerCount: 0 });
    await sdk.close();
  });

  it('records onArtifact after landing a file even when no Host subscribed', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'monitor-artifact-')));
    const transport = fakeTransport();
    const sdk = await createPedelecRuntime({ transport, detailedMonitoring: true });
    try {
      const events: PedelecMonitorEvent[] = [];
      sdk.onMonitorEvent((event) => { events.push(event); });
      const session = await sdk.createSession({
        provider: 'codex', model: 'test', effort: 'default', workdir: directory,
        runtimeStorageRoot: join(directory, 'runtime'), sessionId: 'artifact-session', tools: [],
      });
      await session.sendText('draw', { turnId: 'draw-turn' });
      const staging = join(session.artifactDirectory, '.pedelec-staging', 'artifact-session');
      mkdirSync(staging, { recursive: true });
      const stagedPath = join(staging, 'drawing.png');
      writeFileSync(stagedPath, 'sample-file');
      transport.connections[0]!.push('artifact', {
        turnId: 'draw-turn', kind: 'image', source: 'image_generation', filename: 'drawing.png',
        providerArtifactId: 'image-1', mimeType: 'image/png', bytes: 11,
        sha256: createHash('sha256').update('sample-file').digest('hex'), stagedPath,
      });
      await waitFor(() => events.some((event) => event.kind === 'sdk.onArtifact'));
      expect(events.find((event) => event.kind === 'sdk.onArtifact')?.data).toMatchObject({
        artifact: { name: 'drawing.png', kind: 'image', sizeBytes: 11 },
        context: { turnId: 'draw-turn' }, listenerCount: 0,
      });
    } finally {
      await sdk.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records onError without a subscriber, including the faulted status and end', async () => {
    const transport = fakeTransport();
    const sdk = await createPedelecRuntime({ transport, detailedMonitoring: true });
    const events: PedelecMonitorEvent[] = [];
    sdk.onMonitorEvent((event) => { events.push(event); });
    const session = await sdk.createSession({ provider: 'codex', model: 'test', effort: 'default', workdir: '/srv/test', runtimeStorageRoot: join(storage, 'runtime'), tools: [] });
    const connection = transport.connections[0]!;
    connection.emit('crash');
    await waitFor(() => events.some((event) => event.kind === 'sdk.onError'));
    expect(events.find((event) => event.kind === 'sdk.onError')?.data).toMatchObject({
      error: { category: 'WORKER_CRASHED' }, listenerCount: 0,
    });
    expect(events.find((event) => event.kind === 'sdk.onStatus')?.data).toMatchObject({
      status: 'unavailable', listenerCount: 0,
    });
    await waitFor(() => events.some((event) => event.kind === 'sdk.onEnded'));
    expect(events.find((event) => event.kind === 'sdk.onEnded')?.data).toMatchObject({
      reason: { reason: 'worker-exited' }, listenerCount: 0,
    });
    await sdk.close();
  });
});
