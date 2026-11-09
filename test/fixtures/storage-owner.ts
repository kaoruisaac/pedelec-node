import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPedelecRuntime } from '../../src/index.ts';
import { fakeTransport } from '../fake-transport.ts';

const [runtimeStorageRoot, workdir] = process.argv.slice(2) as [string, string];
const client = await createPedelecRuntime({ transport: fakeTransport() });
const session = await client.createSession({
  provider: 'ollama', model: 'fake', effort: 'default', tools: [], workdir, runtimeStorageRoot, sessionId: 'from-child',
});
writeFileSync(join(session.artifactDirectory, 'landed.png'), 'image');
await session.close('done');
process.stdout.write(JSON.stringify({ artifactDirectory: session.artifactDirectory, providerStateDirectory: session.providerStateDirectory }) + '\n');
await new Promise(() => setInterval(() => undefined, 60_000));
