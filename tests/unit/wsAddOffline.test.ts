import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addAndActivateWorkspace } from "../../src/core/workspace/addWorkspace.js";
import { writeClawMarker } from "../../src/core/workspace/clawMarker.js";
import { resolveWorkspaceAllowedRoots } from "../../src/core/workspace/resolveAllowedRoots.js";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";

/**
 * Offline add path used by `cursor-supervisor ws add` when the service is down:
 * registry + claw marker with the same allowlist rules.
 */
let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("ws add offline path", () => {
  it("persists registry and writes claw marker", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-offline-"));
    const dataDir = join(dir, "data");
    const projects = join(dir, "projects");
    const app = join(projects, "app");
    await mkdir(dataDir, { recursive: true });
    await mkdir(app, { recursive: true });

    const registry = new WorkspaceRegistry(join(dataDir, "workspaces.json"));
    await registry.init({ autoRegisterCwd: false, cwd: projects });
    const allowedRoots = resolveWorkspaceAllowedRoots([], registry, projects);

    const ws = await addAndActivateWorkspace({
      registry,
      name: "app",
      path: app,
      allowedRoots,
      onWorkspaceActivated: (wsPath) => writeClawMarker(wsPath, dataDir),
    });

    expect(ws.name).toBe("app");
    expect(registry.getActive()?.path).toBe(app);

    const reloaded = new WorkspaceRegistry(join(dataDir, "workspaces.json"));
    await reloaded.init({ autoRegisterCwd: false, cwd: projects });
    expect(reloaded.getActive()?.name).toBe("app");

    const marker = await readFile(
      join(app, ".cursor-supervisor", "data-dir.txt"),
      "utf8",
    );
    expect(marker).toBe(resolve(dataDir));
  });
});
