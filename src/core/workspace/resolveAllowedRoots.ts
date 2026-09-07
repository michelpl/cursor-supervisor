import type { WorkspaceRegistry } from "./WorkspaceRegistry.js";

/**
 * Resolve the effective workspace allowlist used by /wsadd and CLI/control add.
 *
 * Empty config `allowedRoots` is not "allow anywhere": default to process cwd
 * plus paths already registered (same F-07 behavior as runBot).
 */
export function resolveWorkspaceAllowedRoots(
  configuredRoots: string[],
  registry: WorkspaceRegistry,
  cwd: string = process.cwd(),
): string[] {
  if (configuredRoots.length > 0) {
    return configuredRoots;
  }
  return [cwd, ...registry.list().map((w) => w.path)];
}
