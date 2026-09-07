import { homedir } from "node:os";
import { join } from "node:path";

export function supervisorHomeDir(home = homedir()): string {
  return join(home, ".cursor-supervisor");
}

export function defaultConfigPath(home = homedir()): string {
  return join(supervisorHomeDir(home), "config.json");
}

export function defaultDataDir(home = homedir()): string {
  return join(supervisorHomeDir(home), "data");
}

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(home, path.slice(2));
  }
  return path;
}

/** Default VS Code setting value for cursorSupervisor.configPath. */
export const DEFAULT_CONFIG_PATH_SETTING =
  "${userHome}/.cursor-supervisor/config.json";
