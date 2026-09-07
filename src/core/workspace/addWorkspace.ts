import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  WorkspaceError,
  type WorkspaceRegistry,
} from "./WorkspaceRegistry.js";
import { isPathWithinAllowedRoots } from "./pathPolicy.js";

export type WorkspaceAddErrorCode =
  | "missing_args"
  | "not_absolute"
  | "not_directory"
  | "not_found"
  | "outside_allowed_roots"
  | "already_exists";

export class WorkspaceAddError extends Error {
  readonly code: WorkspaceAddErrorCode;

  constructor(code: WorkspaceAddErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceAddError";
    this.code = code;
  }
}

export interface ValidateWorkspaceAddInputOpts {
  name?: string;
  path?: string;
  allowedRoots?: string[];
}

/**
 * Validate inputs for workspace add (same rules as Telegram `/wsadd`).
 * Does not check name uniqueness — that happens on `registry.add`.
 */
export async function validateWorkspaceAddInput(
  opts: ValidateWorkspaceAddInputOpts,
): Promise<{ name: string; path: string }> {
  const name = opts.name?.trim();
  const path = opts.path?.trim();
  if (!name || !path) {
    throw new WorkspaceAddError(
      "missing_args",
      "Usage: ws add <name> <abs-path>",
    );
  }
  if (!isAbsolute(path)) {
    throw new WorkspaceAddError("not_absolute", "The path must be absolute.");
  }
  try {
    const s = await stat(path);
    if (!s.isDirectory()) {
      throw new WorkspaceAddError(
        "not_directory",
        "The path must be a directory.",
      );
    }
  } catch (e) {
    if (e instanceof WorkspaceAddError) throw e;
    throw new WorkspaceAddError("not_found", "Directory not found.");
  }

  const roots = opts.allowedRoots ?? [];
  if (roots.length > 0) {
    const allowed = await isPathWithinAllowedRoots(path, roots);
    if (!allowed) {
      throw new WorkspaceAddError(
        "outside_allowed_roots",
        "Path is outside the allowed directories (workspaces.allowedRoots). " +
          "Set workspaces.allowedRoots in config to a parent folder and restart the service.",
      );
    }
  }

  return { name, path };
}

/**
 * Activate a workspace, persist, and refresh claw marker when configured.
 */
export async function applyWsUse(
  registry: WorkspaceRegistry,
  name: string,
  onWorkspaceActivated?: (wsPath: string) => Promise<void>,
): Promise<{ name: string; path: string }> {
  registry.use(name);
  await registry.persist();
  const ws = registry.getActive();
  if (!ws) {
    throw new WorkspaceError(`workspace not found: ${name}`);
  }
  if (onWorkspaceActivated) {
    await onWorkspaceActivated(ws.path);
  }
  return { name: ws.name, path: ws.path };
}

export interface AddAndActivateWorkspaceOpts {
  registry: WorkspaceRegistry;
  name: string;
  path: string;
  allowedRoots?: string[];
  onWorkspaceActivated?: (wsPath: string) => Promise<void>;
}

/**
 * Validate, register, activate, and persist a workspace.
 */
export async function addAndActivateWorkspace(
  opts: AddAndActivateWorkspaceOpts,
): Promise<{ name: string; path: string }> {
  const { name, path } = await validateWorkspaceAddInput({
    name: opts.name,
    path: opts.path,
    allowedRoots: opts.allowedRoots,
  });
  try {
    opts.registry.add(name, path);
  } catch (e) {
    if (e instanceof WorkspaceError) {
      throw new WorkspaceAddError("already_exists", e.message);
    }
    throw e;
  }
  return applyWsUse(opts.registry, name, opts.onWorkspaceActivated);
}
