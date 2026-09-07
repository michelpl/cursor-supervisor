import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../../src/config/loadConfig.js";
import {
  defaultConfigPath,
  defaultDataDir,
  resolveConfigFilePath,
  resolveDataDir,
} from "../../src/config/paths.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cfg-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_SUPERVISOR_CONFIG;
});

describe("loadConfig", () => {
  it("loads minimal JSON with defaults", async () => {
    const p = join(dir, "config.json");
    await writeFile(
      p,
      JSON.stringify({
        telegram: { botToken: "T", allowedUserIds: [42] },
        cursor: { apiKey: "K" },
      }),
      "utf8",
    );
    const cfg = await loadConfig({ configPath: p });
    expect(cfg.telegram.botToken).toBe("T");
    expect(cfg.telegram.parseMode).toBe("HTML");
    expect(cfg.telegram.allowedUserIds).toEqual([42]);
    expect(cfg.cursor.apiKey).toBe("K");
    expect(cfg.cursor.agentCliPath).toBe("agent");
    expect(cfg.cursor.acpMode).toBe("agent");
    expect(cfg.paths.dataDir).toBe(defaultDataDir());
  });

  it("resolves relative dataDir against the config directory", async () => {
    const p = join(dir, "config.json");
    await writeFile(
      p,
      JSON.stringify({
        telegram: { botToken: "T", allowedUserIds: [1] },
        cursor: { apiKey: "K" },
        paths: { dataDir: "./data" },
      }),
      "utf8",
    );
    const cfg = await loadConfig({ configPath: p });
    expect(cfg.paths.dataDir).toBe(resolve(dir, "data"));
  });

  it("expands ~ in dataDir", async () => {
    const p = join(dir, "config.json");
    await writeFile(
      p,
      JSON.stringify({
        telegram: { botToken: "T", allowedUserIds: [1] },
        cursor: { apiKey: "K" },
        paths: { dataDir: "~/.cursor-supervisor/data" },
      }),
      "utf8",
    );
    const cfg = await loadConfig({ configPath: p });
    expect(cfg.paths.dataDir).toBe(defaultDataDir());
  });

  it("env vars override file values", async () => {
    const p = join(dir, "config.json");
    await writeFile(
      p,
      JSON.stringify({
        telegram: { botToken: "T_FILE", allowedUserIds: [1] },
        cursor: { apiKey: "K_FILE" },
      }),
      "utf8",
    );
    process.env.TELEGRAM_BOT_TOKEN = "T_ENV";
    process.env.CURSOR_API_KEY = "K_ENV";
    const cfg = await loadConfig({ configPath: p });
    expect(cfg.telegram.botToken).toBe("T_ENV");
    expect(cfg.cursor.apiKey).toBe("K_ENV");
  });

  it("throws ConfigError on missing botToken", async () => {
    const p = join(dir, "config.json");
    await writeFile(
      p,
      JSON.stringify({
        telegram: { allowedUserIds: [1] },
        cursor: { apiKey: "K" },
      }),
      "utf8",
    );
    await expect(loadConfig({ configPath: p })).rejects.toThrow(/telegram\.botToken/);
  });

  it("requires non-empty allowedUserIds", async () => {
    const p = join(dir, "config.json");
    await writeFile(
      p,
      JSON.stringify({
        telegram: { botToken: "T", allowedUserIds: [] },
        cursor: { apiKey: "K" },
      }),
      "utf8",
    );
    await expect(loadConfig({ configPath: p })).rejects.toThrow(/allowedUserIds/);
  });

  it("M2 sections use schema defaults", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        telegram: { botToken: "x", allowedUserIds: [1] },
        cursor: { apiKey: "y" },
      }),
      "utf8",
    );
    const cfg = await loadConfig({ configPath: path });
    expect(cfg.reminders.timezone).toBe("America/Sao_Paulo");
    expect(cfg.reminders.maxAheadDays).toBe(30);
    expect(cfg.attachments.maxFileSizeBytes).toBe(20 * 1024 * 1024);
    expect(cfg.images.defaultPromptSingle).toContain("Analyze");
    expect(cfg.images.mediaGroupDebounceMs).toBe(800);
    expect(cfg.rateLimit.sessionCreate.capacity).toBe(10);
  });
});

describe("resolveConfigFilePath", () => {
  it("prefers explicit path", async () => {
    const p = join(dir, "explicit.json");
    await writeFile(p, "{}", "utf8");
    const resolved = await resolveConfigFilePath(p, {
      cwd: dir,
      home: join(dir, "home"),
      env: {},
    });
    expect(resolved).toBe(resolve(p));
  });

  it("uses CURSOR_SUPERVISOR_CONFIG", async () => {
    const p = join(dir, "from-env.json");
    await writeFile(p, "{}", "utf8");
    const resolved = await resolveConfigFilePath(undefined, {
      cwd: dir,
      home: join(dir, "home"),
      env: { CURSOR_SUPERVISOR_CONFIG: p },
    });
    expect(resolved).toBe(resolve(p));
  });

  it("prefers global config over cwd legacy", async () => {
    const home = join(dir, "home");
    const global = defaultConfigPath(home);
    await mkdir(join(home, ".cursor-supervisor"), { recursive: true });
    await writeFile(global, "{}", "utf8");
    await writeFile(join(dir, "config.json"), "{}", "utf8");
    const resolved = await resolveConfigFilePath(undefined, {
      cwd: dir,
      home,
      env: {},
    });
    expect(resolved).toBe(global);
  });

  it("falls back to cwd config.json when global is missing", async () => {
    const home = join(dir, "home");
    const legacy = join(dir, "config.json");
    await writeFile(legacy, "{}", "utf8");
    const resolved = await resolveConfigFilePath(undefined, {
      cwd: dir,
      home,
      env: {},
    });
    expect(resolved).toBe(resolve(legacy));
  });

  it("defaults to global path when nothing exists", async () => {
    const home = join(dir, "home");
    const resolved = await resolveConfigFilePath(undefined, {
      cwd: dir,
      home,
      env: {},
    });
    expect(resolved).toBe(defaultConfigPath(home));
  });
});

describe("resolveDataDir", () => {
  it("resolves relative paths against the config directory", () => {
    const cfg = join(dir, ".cursor-supervisor", "config.json");
    expect(resolveDataDir("./data", cfg, dir)).toBe(
      resolve(dir, ".cursor-supervisor", "data"),
    );
  });
});
