import type { JsonValue, PedelecToolDescriptor } from './types.ts';

export const MAX_TOOL_NAME_BYTES = 128;
export const MAX_TOOLS_PER_SESSION = 64;
export const MAX_TOOL_RESULT_BYTES = 64 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Describes a tool's name and argument schema only. It never runs Server business logic. */
export function defineTool(input: PedelecToolDescriptor): PedelecToolDescriptor {
  if (!isPlainObject(input)) throw new TypeError('tool descriptor must be an object');
  const { name, description, argsSchema } = input;
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) || Buffer.byteLength(name) > MAX_TOOL_NAME_BYTES) {
    throw new TypeError('tool name must be an identifier of at most 128 bytes');
  }
  if (typeof description !== 'string' || !description.trim()) throw new TypeError('tool description must be a non-empty string');
  if (!isPlainObject(argsSchema) || argsSchema.type !== 'object') throw new TypeError('tool argsSchema must be an object schema');
  return deepFreeze({ name, description, argsSchema: { ...structuredClone(argsSchema), additionalProperties: argsSchema.additionalProperties ?? false } });
}

export function normalizeTools(tools: readonly PedelecToolDescriptor[]): readonly PedelecToolDescriptor[] {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS_PER_SESSION) {
    throw new TypeError(`tools must contain 0..${MAX_TOOLS_PER_SESSION} descriptors`);
  }
  const normalized = tools.map((tool) => defineTool(tool));
  if (new Set(normalized.map((tool) => tool.name)).size !== normalized.length) throw new TypeError('tool names must be unique');
  return Object.freeze(normalized);
}

/** Returns the JSON value when it is plain JSON within the reply limit; otherwise undefined. */
export function boundedJson(value: unknown): JsonValue | undefined {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { return undefined; }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_TOOL_RESULT_BYTES) return undefined;
  return JSON.parse(serialized) as JsonValue;
}
