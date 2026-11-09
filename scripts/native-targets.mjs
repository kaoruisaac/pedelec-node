// Shared target table for build, staging, manifest and packaging scripts.
export const TARGETS = Object.freeze({
  'darwin-arm64': { triple: 'aarch64-apple-darwin', exe: '' },
  'win32-x64': { triple: 'x86_64-pc-windows-msvc', exe: '.exe' },
  'linux-x64-gnu': { triple: 'x86_64-unknown-linux-gnu', exe: '' },
});
export const BINARIES = Object.freeze(['pedelec-ipc-worker', 'pedelec-agent', 'pedelec-cli']);
export function hostTarget() {
  if (process.platform === 'linux') return `linux-${process.arch}-gnu`;
  return `${process.platform}-${process.arch}`;
}
