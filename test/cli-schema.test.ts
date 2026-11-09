import { expect, it } from 'vitest';
import { defineTool } from '../src/tools.ts';
it('normalizes the tools.json snapshot to reject undeclared fields without mutating Host input', () => {
  const schema = { type: 'object', properties: {} };
  const tool = defineTool({ name: 'echo', description: 'Echo', argsSchema: schema });
  expect(tool.argsSchema).toEqual({ ...schema, additionalProperties: false });
  expect(schema).not.toHaveProperty('additionalProperties');
  expect(Object.isFrozen(tool.argsSchema)).toBe(true);
});
it('preserves explicitly declared extensible schemas', () => {
  const schema = { type: 'object', properties: {}, additionalProperties: true };
  expect(defineTool({ name: 'echo', description: 'Echo', argsSchema: schema }).argsSchema).toEqual(schema);
});
it('rejects unsupported schema keywords and unresolved external references before opening IPC', async () => {
  const { CliEndpoint } = await import('../src/transport/cli-endpoint.ts');
  const unknown = defineTool({ name: 'echo', description: 'Echo', argsSchema: { type: 'object', unsupportedValidation: true } });
  await expect(CliEndpoint.start('s', [unknown])).rejects.toThrow(/strict mode/);
  const remote = defineTool({ name: 'echo', description: 'Echo', argsSchema: { type: 'object', $ref: 'https://example.invalid/schema' } });
  await expect(CliEndpoint.start('s', [remote])).rejects.toThrow(/resolve reference/);
});
