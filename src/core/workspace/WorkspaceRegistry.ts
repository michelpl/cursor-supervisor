import { resolve } from "node:path";
import { JsonStore } from "../persist/jsonStore.js";
import { z } from "zod";

// textname text SDK agentId text"text"textpath text cwdtext
export interface Workspace {
  name: string;
  path: string;
}

interface RegistryFile {
  active?: string;
  items: Record<string, Workspace>;
}

const WorkspaceSchema = z.object({
  name: z.string(),
  path: z.string(),
});

const RegistryFileSchema = z.object({
  active: z.string().optional(),
  items: z.record(WorkspaceSchema),
});

export class WorkspaceError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "WorkspaceError";
  }
}

/**
 * Named workspaces + one active (last used).
 *
 * - Agent cwd comes from the active workspace path
 * - add/use persist via handler I/O
 * - init may register cwd as default or promote a matching path to active
 */
export class WorkspaceRegistry {
  private readonly store: JsonStore<RegistryFile>;
  private state: RegistryFile = { items: {} };

  constructor(filePath: string) {
    this.store = new JsonStore<RegistryFile>(
      filePath,
      { items: {} },
      (raw) => RegistryFileSchema.parse(raw),
    );
  }

  async init(opts: { autoRegisterCwd: boolean; cwd: string }): Promise<void> {
    this.state = await this.store.readOrInit();
    const cwdResolved = resolve(opts.cwd);
    const active = this.getActive();
    const activeAlreadyAtCwd =
      !!active && resolve(active.path) === cwdResolved;
    if (!activeAlreadyAtCwd) {
      const cwdMatch = this.findByPath(opts.cwd);
      if (cwdMatch && this.state.active !== cwdMatch.name) {
        this.state.active = cwdMatch.name;
        await this.persist();
      }
    }
    if (opts.autoRegisterCwd && !this.state.active) {
      this.state.items["default"] = { name: "default", path: opts.cwd };
      this.state.active = "default";
      await this.persist();
    }
  }

  add(name: string, path: string): void {
    if (this.state.items[name]) {
      throw new WorkspaceError(`workspace already exists: ${name}`);
    }
    this.state.items[name] = { name, path };
  }

  remove(name: string): void {
    if (!this.state.items[name]) {
      throw new WorkspaceError(`workspace not found: ${name}`);
    }
    if (this.state.active === name) {
      throw new WorkspaceError(`cannot remove active workspace: ${name}`);
    }
    delete this.state.items[name];
  }

  use(name: string): void {
    if (!this.state.items[name]) {
      throw new WorkspaceError(`workspace not found: ${name}`);
    }
    this.state.active = name;
  }

  getActive(): Workspace | undefined {
    return this.state.active ? this.state.items[this.state.active] : undefined;
  }

  get(name: string): Workspace | undefined {
    return this.state.items[name];
  }

  findByPath(absPath: string): Workspace | undefined {
    const target = resolve(absPath);
    return Object.values(this.state.items).find(
      (w) => resolve(w.path) === target,
    );
  }

  list(): Workspace[] {
    return Object.values(this.state.items);
  }

  async persist(): Promise<void> {
    await this.store.write(this.state);
  }
}
