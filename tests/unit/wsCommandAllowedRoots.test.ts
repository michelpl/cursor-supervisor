import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleWs } from "../../src/commands/handlers/ws.js";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";
import { StubMessenger } from "../helpers/StubMessenger.js";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("/wsadd allowedRoots", () => {
  it("text allowedRoots text", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-cmd-"));
    const allowed = join(dir, "allowed");
    const outside = join(dir, "outside");
    await mkdir(allowed, { recursive: true });
    await mkdir(outside, { recursive: true });

    const registry = new WorkspaceRegistry(join(dir, "ws.json"));
    await registry.init({ autoRegisterCwd: false, cwd: allowed });
    const messenger = new StubMessenger();

    await handleWs(["add", "x", outside], {
      chatId: "C",
      messenger,
      registry,
      workspaceAllowedRoots: [allowed],
    } as never);

    expect(registry.get("x")).toBeUndefined();
    expect(
      messenger.sentTexts.some((m) =>
        m.text.includes("allowed"),
      ),
    ).toBe(true);
  });

  it("text allowedRoots text", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-cmd-"));
    const allowed = join(dir, "allowed");
    const child = join(allowed, "child");
    await mkdir(child, { recursive: true });

    const registry = new WorkspaceRegistry(join(dir, "ws.json"));
    await registry.init({ autoRegisterCwd: false, cwd: allowed });
    const messenger = new StubMessenger();

    await handleWs(["add", "x", child], {
      chatId: "C",
      messenger,
      registry,
      workspaceAllowedRoots: [allowed],
    } as never);

    expect(registry.get("x")?.path).toBe(child);
  });
});
