import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addAndActivateWorkspace,
  validateWorkspaceAddInput,
  WorkspaceAddError,
} from "../../src/core/workspace/addWorkspace.js";
import { resolveWorkspaceAllowedRoots } from "../../src/core/workspace/resolveAllowedRoots.js";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("validateWorkspaceAddInput", () => {
  it("rejects missing args", async () => {
    await expect(validateWorkspaceAddInput({})).rejects.toMatchObject({
      code: "missing_args",
    });
  });

  it("rejects relative path", async () => {
    await expect(
      validateWorkspaceAddInput({ name: "x", path: "relative" }),
    ).rejects.toMatchObject({ code: "not_absolute" });
  });

  it("rejects missing directory", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-add-val-"));
    await expect(
      validateWorkspaceAddInput({
        name: "x",
        path: join(dir, "nope"),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects file that is not a directory", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-add-val-"));
    const file = join(dir, "file.txt");
    await writeFile(file, "x");
    await expect(
      validateWorkspaceAddInput({ name: "x", path: file }),
    ).rejects.toMatchObject({ code: "not_directory" });
  });

  it("rejects path outside allowed roots", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-add-val-"));
    const allowed = join(dir, "allowed");
    const outside = join(dir, "outside");
    await mkdir(allowed, { recursive: true });
    await mkdir(outside, { recursive: true });
    await expect(
      validateWorkspaceAddInput({
        name: "x",
        path: outside,
        allowedRoots: [allowed],
      }),
    ).rejects.toMatchObject({ code: "outside_allowed_roots" });
  });
});

describe("addAndActivateWorkspace", () => {
  it("adds, activates, and calls onWorkspaceActivated", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-add-act-"));
    const child = join(dir, "app");
    await mkdir(child, { recursive: true });
    const registry = new WorkspaceRegistry(join(dir, "ws.json"));
    await registry.init({ autoRegisterCwd: false, cwd: dir });
    const markers: string[] = [];
    const ws = await addAndActivateWorkspace({
      registry,
      name: "app",
      path: child,
      allowedRoots: [dir],
      onWorkspaceActivated: async (p) => {
        markers.push(p);
      },
    });
    expect(ws).toEqual({ name: "app", path: child });
    expect(registry.getActive()?.name).toBe("app");
    expect(markers).toEqual([child]);
  });

  it("maps duplicate name to already_exists", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-add-dup-"));
    const registry = new WorkspaceRegistry(join(dir, "ws.json"));
    await registry.init({ autoRegisterCwd: false, cwd: dir });
    registry.add("app", dir);
    await expect(
      addAndActivateWorkspace({
        registry,
        name: "app",
        path: dir,
        allowedRoots: [dir],
      }),
    ).rejects.toMatchObject({ code: "already_exists" });
  });
});

describe("resolveWorkspaceAllowedRoots", () => {
  it("uses configured roots when non-empty", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-roots-"));
    const registry = new WorkspaceRegistry(join(dir, "ws.json"));
    await registry.init({ autoRegisterCwd: false, cwd: dir });
    expect(resolveWorkspaceAllowedRoots(["/a", "/b"], registry, dir)).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("defaults to cwd plus registered paths", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-roots-"));
    const other = join(dir, "other");
    await mkdir(other, { recursive: true });
    const registry = new WorkspaceRegistry(join(dir, "ws.json"));
    await registry.init({ autoRegisterCwd: false, cwd: dir });
    registry.add("other", other);
    expect(resolveWorkspaceAllowedRoots([], registry, dir)).toEqual([
      dir,
      other,
    ]);
  });
});

describe("WorkspaceAddError", () => {
  it("is instanceof Error with code", () => {
    const e = new WorkspaceAddError("not_found", "Directory not found.");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("not_found");
  });
});
