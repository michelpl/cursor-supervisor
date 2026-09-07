import { spawn, execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { promisify } from "node:util";
import { expandHome } from "./paths";

const execFileAsync = promisify(execFile);
const DIST_ENTRY = join("dist", "bin", "cursor-supervisor.js");
const BIN_NAME = "cursor-supervisor";
const BUNDLED_ENTRY = join("server", "bin", "cursor-supervisor.js");

export interface ServiceStatus {
  running: boolean;
  stale?: boolean;
  pid?: number;
  startedAt?: string;
  configPath?: string;
  cwd?: string;
  startedBy?: string;
  controlReady?: boolean;
}

export interface ResolvedExecutable {
  command: string;
  args: string[];
  cwd: string;
  shell: boolean;
}

export interface ServiceClientOptions {
  workspaceRoot: string;
  configPath: string;
  nodePath: string;
  executablePath: string;
  detach: boolean;
  extensionPath?: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isWindows(): boolean {
  return process.platform === "win32";
}

/** Avoid pino-pretty (and other dev transports) when spawned from the IDE. */
function serviceEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" };
}

function cmdShim(path: string): string {
  return isWindows() ? `${path}.cmd` : path;
}

async function findDistEntry(
  startDir: string,
): Promise<{ distJs: string; root: string } | null> {
  let dir = resolve(startDir);
  for (let i = 0; i < 5; i++) {
    const distJs = join(dir, DIST_ENTRY);
    if (await fileExists(distJs)) {
      return { distJs, root: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function findLocalBin(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);
  for (let i = 0; i < 5; i++) {
    const localBin = join(dir, "node_modules", ".bin", BIN_NAME);
    const localShim = cmdShim(localBin);
    if (await fileExists(localShim)) return localShim;
    if (await fileExists(localBin)) return localBin;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function searchRoots(
  opts: Pick<ServiceClientOptions, "workspaceRoot" | "extensionPath">,
): string[] {
  const roots = new Set<string>();
  roots.add(resolve(opts.workspaceRoot));
  if (opts.extensionPath) {
    roots.add(resolve(opts.extensionPath));
    roots.add(dirname(resolve(opts.extensionPath)));
  }
  return [...roots];
}

async function findBundled(
  opts: Pick<ServiceClientOptions, "extensionPath" | "nodePath" | "workspaceRoot">,
): Promise<ResolvedExecutable | null> {
  if (!opts.extensionPath) return null;
  const bundled = join(resolve(opts.extensionPath), BUNDLED_ENTRY);
  if (!(await fileExists(bundled))) return null;
  return {
    command: opts.nodePath || "node",
    args: [bundled],
    cwd: resolve(opts.workspaceRoot),
    shell: false,
  };
}

/**
 * Resolve how to invoke Cursor Supervisor for this workspace.
 * Order: override → bundled VSIX server → local workspace → PATH.
 */
export async function resolveExecutable(
  opts: Pick<
    ServiceClientOptions,
    "workspaceRoot" | "nodePath" | "executablePath" | "extensionPath"
  >,
): Promise<ResolvedExecutable> {
  if (opts.executablePath.trim()) {
    const abs = resolve(opts.executablePath);
    if (!(await fileExists(abs))) {
      throw new Error(`cursorSupervisor.executablePath not found: ${abs}`);
    }
    return {
      command: abs,
      args: [],
      cwd: resolve(opts.workspaceRoot),
      shell: abs.endsWith(".cmd"),
    };
  }

  const bundled = await findBundled(opts);
  if (bundled) return bundled;

  for (const start of searchRoots(opts)) {
    const localBin = await findLocalBin(start);
    if (localBin) {
      const found = await findDistEntry(start);
      return {
        command: localBin,
        args: [],
        cwd: found?.root ?? resolve(opts.workspaceRoot),
        shell: localBin.endsWith(".cmd"),
      };
    }
  }

  for (const start of searchRoots(opts)) {
    const dist = await findDistEntry(start);
    if (dist) {
      return {
        command: opts.nodePath || "node",
        args: [dist.distJs],
        cwd: dist.root,
        shell: false,
      };
    }
  }

  const pathBin = cmdShim(BIN_NAME);
  return {
    command: pathBin,
    args: [],
    cwd: resolve(opts.workspaceRoot),
    shell: isWindows(),
  };
}

function buildArgv(
  exe: ResolvedExecutable,
  subcommand: string,
  configPath: string,
  extra: string[] = [],
): { command: string; args: string[] } {
  const configFlag = ["--config-path", resolve(configPath)];
  if (exe.args.length > 0) {
    return {
      command: exe.command,
      args: [...exe.args, subcommand, ...configFlag, ...extra],
    };
  }
  return {
    command: exe.command,
    args: [subcommand, ...configFlag, ...extra],
  };
}

export class ServiceClient {
  constructor(private readonly opts: ServiceClientOptions) {}

  private async exe(): Promise<ResolvedExecutable> {
    return resolveExecutable(this.opts);
  }

  async getStatus(): Promise<ServiceStatus> {
    const exe = await this.exe();
    const { command, args } = buildArgv(exe, "status", this.opts.configPath, [
      "--json",
    ]);
    try {
      const { stdout } = await execFileAsync(command, args, {
        cwd: exe.cwd,
        shell: exe.shell,
        windowsHide: true,
        env: serviceEnv(),
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      return JSON.parse(stdout.trim()) as ServiceStatus;
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      throw new Error(
        `cursor-supervisor status failed: ${err.stderr ?? err.message ?? String(e)}`,
      );
    }
  }

  async stop(timeoutMs = 15_000): Promise<string> {
    const exe = await this.exe();
    const { command, args } = buildArgv(exe, "stop", this.opts.configPath, [
      "--timeout-ms",
      String(timeoutMs),
    ]);
    try {
      const { stdout } = await execFileAsync(command, args, {
        cwd: exe.cwd,
        shell: exe.shell,
        windowsHide: true,
        env: serviceEnv(),
        timeout: timeoutMs + 5_000,
        maxBuffer: 64 * 1024,
      });
      return stdout.trim();
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message?: string };
      const msg = err.stderr ?? err.stdout ?? err.message ?? String(e);
      throw new Error(`cursor-supervisor stop failed: ${msg}`);
    }
  }

  async start(): Promise<void> {
    const exe = await this.exe();
    const { command, args } = buildArgv(exe, "run", this.opts.configPath, [
      "--started-by",
      "extension",
    ]);

    const firstArg = exe.args[0];
    if (firstArg && firstArg.endsWith(".js") && !(await fileExists(firstArg))) {
      throw new Error(
        `Service entry not found: ${firstArg}. Rebuild the extension or run npm run build in the project root.`,
      );
    }

    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: exe.cwd,
        shell: exe.shell,
        detached: this.opts.detach,
        stdio: this.opts.detach ? "ignore" : "pipe",
        windowsHide: true,
        env: serviceEnv(),
      });

      if (!this.opts.detach) {
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolvePromise();
          else reject(new Error(stderr || `cursor-supervisor exited with code ${code}`));
        });
        return;
      }

      child.on("error", reject);
      child.unref();
      setTimeout(() => resolvePromise(), 500);
    });
  }

  /**
   * Start an ACP prompt via the running service (mirrors progress to Telegram).
   */
  async prompt(input: {
    text: string;
    force?: boolean;
    workspaceId?: string;
  }): Promise<string> {
    const exe = await this.exe();
    const { command, args } = buildArgv(exe, "prompt", this.opts.configPath, [
      ...(input.force ? ["--force"] : []),
      ...(input.workspaceId ? ["--workspace", input.workspaceId] : []),
      input.text,
    ]);
    try {
      const { stdout } = await execFileAsync(command, args, {
        cwd: exe.cwd,
        shell: exe.shell,
        windowsHide: true,
        env: serviceEnv(),
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
      return stdout.trim();
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message?: string };
      const msg = (err.stderr ?? err.stdout ?? err.message ?? String(e)).trim();
      throw new Error(msg || "cursor-supervisor prompt failed");
    }
  }
}

export function resolveConfigPath(
  workspaceRoot: string,
  setting: string,
  home = homedir(),
): string {
  const replaced = setting
    .replace(/\$\{workspaceFolder\}/g, workspaceRoot)
    .replace(/\$\{userHome\}/g, home)
    .replace(/\$\{env:USERPROFILE\}/g, process.env.USERPROFILE || home)
    .replace(/\$\{env:HOME\}/g, process.env.HOME || home);
  return resolve(expandHome(replaced, home));
}

export async function workspaceHasConfig(configPath: string): Promise<boolean> {
  return fileExists(configPath);
}
