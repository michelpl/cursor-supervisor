import { join } from "node:path";
import { loadConfig } from "../config/loadConfig.js";
import { resolveConfigFilePath } from "../config/paths.js";
import { ServiceLock } from "../core/service/ServiceLock.js";
import { postControlWorkspaceAdd } from "../core/service/controlClient.js";
import {
  addAndActivateWorkspace,
  WorkspaceAddError,
  type WorkspaceAddErrorCode,
} from "../core/workspace/addWorkspace.js";
import { writeClawMarker } from "../core/workspace/clawMarker.js";
import { resolveWorkspaceAllowedRoots } from "../core/workspace/resolveAllowedRoots.js";
import { WorkspaceRegistry } from "../core/workspace/WorkspaceRegistry.js";

export interface WsAddResult {
  name: string;
  path: string;
  via: "control" | "offline";
}

/**
 * Add and activate a workspace: prefer live ControlServer when the service
 * is running; otherwise update the registry file + claw marker offline.
 */
export async function wsAddCommand(opts: {
  name: string;
  path: string;
  configPath?: string;
}): Promise<WsAddResult> {
  const abs = await resolveConfigFilePath(opts.configPath);
  const cfg = await loadConfig({ configPath: abs });
  const lock = new ServiceLock(cfg.paths.dataDir);
  const status = await lock.readStatus();

  if (
    status.running &&
    status.record?.controlPort &&
    status.record.controlToken
  ) {
    const result = await postControlWorkspaceAdd(
      status.record.controlPort,
      status.record.controlToken,
      { name: opts.name, path: opts.path },
    );
    if (result.ok && result.status === 200) {
      const body = result.body as { name: string; path: string };
      return { name: body.name, path: body.path, via: "control" };
    }
    const errBody =
      result.body && typeof result.body === "object"
        ? (result.body as { error?: unknown; message?: unknown })
        : {};
    const known: WorkspaceAddErrorCode[] = [
      "missing_args",
      "not_absolute",
      "not_directory",
      "not_found",
      "outside_allowed_roots",
      "already_exists",
    ];
    const code: WorkspaceAddErrorCode =
      typeof errBody.error === "string" &&
      known.includes(errBody.error as WorkspaceAddErrorCode)
        ? (errBody.error as WorkspaceAddErrorCode)
        : result.status === 409
          ? "already_exists"
          : "missing_args";
    const message =
      typeof errBody.message === "string"
        ? errBody.message
        : typeof errBody.error === "string"
          ? errBody.error
          : `HTTP ${result.status}`;
    throw new WorkspaceAddError(code, message);
  }

  const registry = new WorkspaceRegistry(
    join(cfg.paths.dataDir, "workspaces.json"),
  );
  await registry.init({
    autoRegisterCwd: false,
    cwd: process.cwd(),
  });
  const allowedRoots = resolveWorkspaceAllowedRoots(
    cfg.workspaces.allowedRoots,
    registry,
  );
  const ws = await addAndActivateWorkspace({
    registry,
    name: opts.name,
    path: opts.path,
    allowedRoots,
    onWorkspaceActivated: (wsPath) =>
      writeClawMarker(wsPath, cfg.paths.dataDir),
  });
  return { name: ws.name, path: ws.path, via: "offline" };
}
