import { describe, it, expect } from "vitest";
import {
  acpSpawnOptions,
  buildAcpEnv,
  resolveAgentCliPath,
  resolveAcpSpawnTarget,
  unwrapWindowsAgentLauncher,
} from "../../src/adapters/acp/AcpProcess.js";

describe("resolveAgentCliPath", () => {
  it("returns absolute paths unchanged", () => {
    expect(resolveAgentCliPath("C:\\tools\\agent.cmd")).toBe("C:\\tools\\agent.cmd");
  });

  it("on Windows resolves bare agent to agent.cmd when installed", () => {
    if (process.platform !== "win32") return;
    const resolved = resolveAgentCliPath("agent");
    expect(resolved).toMatch(/agent\.cmd$/i);
  });
});

describe("unwrapWindowsAgentLauncher", () => {
  it("unwraps LocalAppData agent.cmd to node.exe + index.js when present", () => {
    if (process.platform !== "win32") return;
    const local = process.env.LOCALAPPDATA;
    if (!local) return;
    const launcher = `${local}\\cursor-agent\\agent.cmd`;
    const unwrapped = unwrapWindowsAgentLauncher(launcher);
    if (!unwrapped) {
      // CLI not installed in this environment
      return;
    }
    expect(unwrapped.nodePath.toLowerCase()).toMatch(/node\.exe$/);
    expect(unwrapped.indexPath.toLowerCase()).toMatch(/index\.js$/);
  });

  it("returns undefined on non-windows-looking paths", () => {
    if (process.platform === "win32") {
      expect(unwrapWindowsAgentLauncher("/usr/local/bin/agent")).toBeUndefined();
    }
  });
});

describe("resolveAcpSpawnTarget", () => {
  it("on Windows prefers direct node spawn over agent.cmd shell", () => {
    if (process.platform !== "win32") return;
    const target = resolveAcpSpawnTarget("agent");
    if (!target.command.toLowerCase().endsWith("node.exe")) {
      // agent CLI not installed
      expect(target.args).toEqual(["acp"]);
      return;
    }
    expect(target.shell).toBe(false);
    expect(target.args).toHaveLength(2);
    expect(target.args[0]?.toLowerCase()).toMatch(/index\.js$/);
    expect(target.args[1]).toBe("acp");
  });
});

describe("acpSpawnOptions", () => {
  it("uses shell on Windows for bare agent name", () => {
    if (process.platform !== "win32") return;
    expect(acpSpawnOptions("agent")).toEqual({ shell: true });
  });

  it("uses shell on Windows for .cmd paths", () => {
    if (process.platform !== "win32") return;
    expect(acpSpawnOptions("C:\\cursor-agent\\agent.cmd")).toEqual({ shell: true });
  });

  it("does not use shell for unix absolute paths", () => {
    expect(acpSpawnOptions("/usr/local/bin/agent")).toEqual({ shell: false });
  });
});

describe("buildAcpEnv", () => {
  const SYNTHETIC_BOT_TOKEN = "0000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA00000";

  it("strips TELEGRAM_BOT_TOKEN and related keys", () => {
    const env = buildAcpEnv(
      {
        PATH: "/usr/bin",
        TELEGRAM_BOT_TOKEN: SYNTHETIC_BOT_TOKEN,
        BOT_TOKEN: SYNTHETIC_BOT_TOKEN,
        TG_BOT_TOKEN: SYNTHETIC_BOT_TOKEN,
        TELEGRAM_TOKEN: SYNTHETIC_BOT_TOKEN,
        KEEP_ME: "ok",
      },
      "key_testapikeyvalue1234567890",
    );
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.BOT_TOKEN).toBeUndefined();
    expect(env.TG_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_TOKEN).toBeUndefined();
    expect(env.KEEP_ME).toBe("ok");
    expect(env.CURSOR_API_KEY).toBe("key_testapikeyvalue1234567890");
  });

  it("strips any env value that looks like a BotFather token", () => {
    const env = buildAcpEnv({
      PATH: "/usr/bin",
      CUSTOM_SECRET: SYNTHETIC_BOT_TOKEN,
      NORMAL: "hello",
    });
    expect(env.CUSTOM_SECRET).toBeUndefined();
    expect(env.NORMAL).toBe("hello");
  });
});
