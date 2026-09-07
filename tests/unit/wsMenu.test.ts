import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWsUse,
  parseWsUseCallback,
  isWsUseCallbackDataFits,
  isWsCreateHelpCallback,
  wsUseCallbackData,
  WS_CREATE_CALLBACK_DATA,
  handleWs,
} from "../../src/commands/handlers/ws.js";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";
import { StubMessenger } from "../helpers/StubMessenger.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("ws menu helpers", () => {
  it("parseWsUseCallback extracts name", () => {
    expect(parseWsUseCallback("ws:use:alpha")).toBe("alpha");
    expect(parseWsUseCallback("ws:use:")).toBeUndefined();
    expect(parseWsUseCallback("acp:xyz")).toBeUndefined();
  });

  it("detects create-help callback", () => {
    expect(isWsCreateHelpCallback(WS_CREATE_CALLBACK_DATA)).toBe(true);
    expect(isWsCreateHelpCallback("ws:use:x")).toBe(false);
  });

  it("rejects callback data over Telegram limit", () => {
    const long = "a".repeat(60);
    expect(isWsUseCallbackDataFits("short")).toBe(true);
    expect(isWsUseCallbackDataFits(long)).toBe(false);
    expect(Buffer.byteLength(wsUseCallbackData("ok"), "utf8")).toBeLessThanOrEqual(
      64,
    );
  });

  it("applyWsUse activates and persists", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-use-"));
    const registry = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await registry.init({ autoRegisterCwd: true, cwd: dir });
    registry.add("alpha", dir);
    const markers: string[] = [];
    const ws = await applyWsUse(registry, "alpha", async (p) => {
      markers.push(p);
    });
    expect(ws.name).toBe("alpha");
    expect(registry.getActive()?.name).toBe("alpha");
    expect(markers).toEqual([dir]);

    const reloaded = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await reloaded.init({ autoRegisterCwd: false, cwd: dir });
    expect(reloaded.getActive()?.name).toBe("alpha");
  });

  it("/wslist includes create button and omits oversized names from use buttons", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-list-"));
    const registry = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await registry.init({ autoRegisterCwd: true, cwd: dir });
    const longName = "n".repeat(60);
    registry.add(longName, dir);
    await registry.persist();
    const messenger = new StubMessenger();
    await handleWs(["list"], {
      chatId: "c1",
      messenger,
      registry,
    } as never);
    const interactive = messenger.calls.find((c) => c.kind === "sendInteractive");
    expect(interactive?.kind).toBe("sendInteractive");
    if (interactive?.kind === "sendInteractive") {
      expect(interactive.msg.buttons.every((b) => b.id !== `ws:use:${longName}`)).toBe(
        true,
      );
      expect(interactive.msg.text).toMatch(/too long for buttons/i);
      expect(interactive.msg.buttons.some((b) => b.id === "ws:use:default")).toBe(
        true,
      );
      expect(interactive.msg.buttons.some((b) => b.id === WS_CREATE_CALLBACK_DATA)).toBe(
        true,
      );
    }
  });

  it("/wslist empty still offers create button", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-empty-"));
    const registry = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await registry.init({ autoRegisterCwd: false, cwd: dir });
    const messenger = new StubMessenger();
    await handleWs(["list"], {
      chatId: "c1",
      messenger,
      registry,
    } as never);
    const interactive = messenger.calls.find((c) => c.kind === "sendInteractive");
    expect(interactive?.kind).toBe("sendInteractive");
    if (interactive?.kind === "sendInteractive") {
      expect(interactive.msg.text).toMatch(/No workspaces registered/i);
      expect(interactive.msg.buttons).toEqual([
        { id: WS_CREATE_CALLBACK_DATA, label: "+ New workspace" },
      ]);
    }
  });
});
