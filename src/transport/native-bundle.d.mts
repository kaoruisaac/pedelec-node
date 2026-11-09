export declare const NATIVE_PROTOCOL_VERSION: 1;
export declare const NATIVE_BINARIES: readonly ['pedelec-ipc-worker', 'pedelec-agent', 'pedelec-cli'];
export declare const SUPPORTED_TARGETS: readonly ['darwin-arm64', 'win32-x64', 'linux-x64-gnu'];
export declare const PACKAGE_ROOT: string;

export type NativeBundleErrorCode =
  | 'NATIVE_UNSUPPORTED_PLATFORM'
  | 'NATIVE_MANIFEST_MISSING'
  | 'NATIVE_MANIFEST_MISMATCH'
  | 'NATIVE_BINARY_MISSING'
  | 'NATIVE_BINARY_INVALID';

export declare class NativeBundleError extends Error {
  readonly code: NativeBundleErrorCode;
  constructor(code: NativeBundleErrorCode, message: string);
}

export type NativeBundle = Readonly<{ target: string; directory: string; worker: string; agent: string; cli: string; version: string }>;

export declare function nativeTarget(platform?: NodeJS.Platform, arch?: string, glibc?: string | null): string;
export declare function resolveNativeBundle(options?: Readonly<{ root?: string; target?: string }>): NativeBundle;
export declare function validateExplicitWorker(binaryPath: unknown): string;
