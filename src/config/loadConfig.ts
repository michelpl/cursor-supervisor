import { readFile } from "node:fs/promises";
import { ConfigSchema, ConfigError, type AppConfig } from "./schema.js";
import { resolveConfigFilePath, resolveDataDir } from "./paths.js";

export interface LoadConfigOptions {
  /** Explicit config path (`--config-path`). When omitted, uses global/env/legacy resolution. */
  configPath?: string;
}

/**
 * Load and validate config.
 *
 * 1. Resolve config path (explicit → env → global → legacy cwd)
 * 2. Parse JSON
 * 3. Overlay TELEGRAM_BOT_TOKEN / CURSOR_API_KEY
 * 4. Validate with zod
 * 5. Resolve `paths.dataDir` to an absolute path (relative to the config file)
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<AppConfig> {
  const path = await resolveConfigFilePath(opts.configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`config file not found: ${path}`);
    }
    throw new ConfigError(`failed to parse config: ${(e as Error).message}`);
  }

  const overlay = applyEnvOverlay(raw);
  const parsed = ConfigSchema.safeParse(overlay);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`config validation failed:\n${issues}`);
  }
  const cfg = parsed.data;
  return {
    ...cfg,
    paths: {
      ...cfg.paths,
      dataDir: resolveDataDir(cfg.paths.dataDir, path),
    },
  };
}

/** Resolve the config path the same way `loadConfig` / the CLI do (without reading the file). */
export { resolveConfigFilePath } from "./paths.js";

// Env overlay for .env / systemd EnvironmentFile
function applyEnvOverlay(raw: unknown): unknown {
  const r = (raw && typeof raw === "object"
    ? { ...(raw as Record<string, unknown>) }
    : {}) as {
    telegram?: Record<string, unknown>;
    cursor?: Record<string, unknown>;
  };
  if (process.env.TELEGRAM_BOT_TOKEN) {
    r.telegram = { ...(r.telegram ?? {}), botToken: process.env.TELEGRAM_BOT_TOKEN };
  }
  if (process.env.CURSOR_API_KEY) {
    r.cursor = { ...(r.cursor ?? {}), apiKey: process.env.CURSOR_API_KEY };
  }
  return r;
}
