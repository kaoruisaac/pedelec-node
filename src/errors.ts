export type PedelecErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_PROVIDER'
  | 'DUPLICATE_SESSION'
  | 'SESSION_BUSY'
  | 'DUPLICATE_TURN'
  | 'NO_ACTIVE_TURN'
  | 'HANDLER_MISSING'
  | 'SESSION_NOT_ACTIVE'
  | 'TRANSPORT_UNAVAILABLE'
  | 'PROVIDER_REJECTED'
  | 'OUTCOME_UNKNOWN'
  | 'CLIENT_CLOSED';

/** Readable, sanitised SDK refusal. `transportCode` keeps the Rust/IPC code for diagnostics only. */
export class PedelecError extends Error {
  readonly code: PedelecErrorCode;
  readonly transportCode: string | undefined;
  constructor(code: PedelecErrorCode, message: string, transportCode?: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'PedelecError';
    this.code = code;
    this.transportCode = transportCode;
  }
}

export function transportCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
}
