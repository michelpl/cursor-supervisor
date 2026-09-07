import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const CONFIG_ENV = "CURSOR_SUPERVISOR_CONFIG";
export const DATA_DIR_ENV = "CURSOR_SUPERVISOR_DATA_DIR";

/** User-global state root: `~/.cursor-supervisor`. */
export function supervisorHomeDir(home = homedir()): string {
  return join(home, ".cursor-supervisor");
}

export function defaultConfigPath(home = homedir()): string {
  return join(supervisorHomeDir(home), "config.json");
}

export function defaultDataDir(home = homedir()): string {
  return join(supervisorHomeDir(home), "data");
}

/** Expand a leading `~` to the user home directory. */
export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(home, path.slice(2));
  }
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve which config.json to use.
 *
 * Priority:
 * 1. Explicit path (`--config-path`)
 * 2. `CURSOR_SUPERVISOR_CONFIG`
 * 3. Existing `~/.cursor-supervisor/config.json`
 * 4. Legacy `./config.json` (cwd)
 * 5. Legacy `./.cursor-supervisor/config.json` (cwd)
 * 6. Default global path (even if missing — for clear errors / first-run)
 */
export async function resolveConfigFilePath(
  explicit?: string,
  opts: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;

  if (explicit && explicit.trim()) {
    return resolve(cwd, expandHome(explicit.trim(), home));
  }

  const fromEnv = env[CONFIG_ENV]?.trim();
  if (fromEnv) {
    return resolve(cwd, expandHome(fromEnv, home));
  }

  const globalPath = defaultConfigPath(home);
  if (await exists(globalPath)) return globalPath;

  const legacyCwd = resolve(cwd, "config.json");
  if (await exists(legacyCwd)) return legacyCwd;

  const legacyNested = resolve(cwd, ".cursor-supervisor", "config.json");
  if (await exists(legacyNested)) return legacyNested;

  return globalPath;
}

/**
 * Make `paths.dataDir` absolute.
 * Relative values are resolved against the config file directory (not cwd),
 * so a global config with `./data` lands in `~/.cursor-supervisor/data`.
 */
export function resolveDataDir(
  dataDir: string,
  configPath: string,
  home = homedir(),
): string {
  const expanded = expandHome(dataDir.trim() || defaultDataDir(home), home);
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(dirname(resolve(configPath)), expanded);
}
