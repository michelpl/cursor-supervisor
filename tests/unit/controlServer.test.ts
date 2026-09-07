import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer } from "../../src/core/service/ControlServer.js";
import type { AgentOrchestrator } from "../../src/core/orchestrator/AgentOrchestrator.js";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";

describe("ControlServer", () => {
  let server: ControlServer;
  let runPrompt: ReturnType<typeof vi.fn>;
  let busy = false;
  let dir: string;
  let registry: WorkspaceRegistry;
  const token = "test-token-abc";

  beforeEach(async () => {
    runPrompt = vi.fn().mockResolvedValue(undefined);
    busy = false;
    dir = await mkdtemp(join(tmpdir(), "ctrl-ws-"));
    registry = new WorkspaceRegistry(join(dir, "ws.json"));
    await registry.init({ autoRegisterCwd: false, cwd: dir });
    server = new ControlServer({
      orchestrator: { runPrompt } as unknown as AgentOrchestrator,
      chatId: "123",
      userId: 123,
      token,
      isBusy: () => busy,
      registry,
      workspaceAllowedRoots: [dir],
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects missing bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${server.getPort()}/v1/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts prompt with 202", async () => {
    const res = await fetch(`http://127.0.0.1:${server.getPort()}/v1/prompt`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "fix it", origin: "cli" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);
    await vi.waitFor(() => expect(runPrompt).toHaveBeenCalled());
    expect(runPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "123",
        text: "fix it",
        origin: "cli",
        userId: 123,
      }),
    );
  });

  it("returns 409 when busy without force", async () => {
    busy = true;
    const res = await fetch(`http://127.0.0.1:${server.getPort()}/v1/prompt`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(409);
    expect(runPrompt).not.toHaveBeenCalled();
  });

  it("adds workspace via POST /v1/workspaces", async () => {
    const child = join(dir, "proj");
    await mkdir(child, { recursive: true });
    const res = await fetch(`http://127.0.0.1:${server.getPort()}/v1/workspaces`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "proj", path: child }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      path: string;
      active: boolean;
    };
    expect(body).toEqual({ name: "proj", path: child, active: true });
    expect(registry.getActive()?.name).toBe("proj");
  });

  it("returns 400 for path outside allowed roots", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ctrl-out-"));
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.getPort()}/v1/workspaces`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "x", path: outside }),
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("outside_allowed_roots");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("returns 409 when workspace name already exists", async () => {
    const child = join(dir, "dup");
    await mkdir(child, { recursive: true });
    registry.add("dup", child);
    await registry.persist();

    const res = await fetch(`http://127.0.0.1:${server.getPort()}/v1/workspaces`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "dup", path: child }),
    });
    expect(res.status).toBe(409);
  });
});
