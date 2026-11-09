import { resolveNativeBundle, SUPPORTED_TARGETS } from './transport/native-bundle.mjs';
import { PedelecError, transportCodeOf } from './errors.ts';

export type NativeRuntimeInfo = Readonly<{
  /** Bundle key for this host, e.g. `darwin-arm64`, `win32-x64`, `linux-x64-gnu`. */
  target: string;
  /** Package version the native executables were built and verified for. */
  version: string;
  supportedTargets: readonly string[];
}>;

/**
 * Verifies this platform's packaged native runtime (manifest, version, size, SHA-256) without starting it.
 * Rejects with `TRANSPORT_UNAVAILABLE` and a readable message on an unsupported platform or a damaged install.
 * Executable paths are deliberately not part of the public contract.
 */
export function nativeRuntimeInfo(): NativeRuntimeInfo {
  try {
    const bundle = resolveNativeBundle();
    return Object.freeze({ target: bundle.target, version: bundle.version, supportedTargets: SUPPORTED_TARGETS });
  } catch (error) {
    throw new PedelecError('TRANSPORT_UNAVAILABLE', error instanceof Error ? error.message : 'native runtime unavailable', transportCodeOf(error), error);
  }
}
