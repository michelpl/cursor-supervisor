import {
  spawn,
  execSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { platform } from "node:os";
import { logger } from "../../logger.js";
import type { LineTransport } from "./JsonRpcClient.js";

export interface AcpProcessOptions {
  agentCliPath: string;
  apiKey?: string;
  cwd: string;
}

export interface AcpSpawnTarget {
  command: string;
  args: string[];
  shell: boolean;
  /** Path shown in logs / errors (launcher or unwrapped entry). */
  displayPath: string;
}

/**
 * Resolve bare CLI names to an absolute executable path.
 * Node subprocesses often inherit a PATH without cursor-agent (Windows).
 */
export function resolveAgentCliPath(agentCliPath: string): string {
  if (/[\\/]/.test(agentCliPath)) {
    return agentCliPath;
  }

  if (platform() === "win32") {
    try {
      const out = execSync(`where ${agentCliPath}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const first = out.trim().split(/\r?\n/)[0]?.trim();
      if (first && existsSync(first)) return first;
    } catch {
      /* not on PATH for this process */
    }

    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const name of ["agent.cmd", "cursor-agent.cmd"]) {
        const candidate = join(localAppData, "cursor-agent", name);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  return agentCliPath;
}

/**
 * Windows `agent.cmd` launches PowerShell → node. Piping stdin through that
 * chain is fragile (especially when the parent is a detached IDE service).
 * Prefer spawning the versioned node.exe + index.js directly.
 */
export function unwrapWindowsAgentLauncher(
  resolvedPath: string,
): { nodePath: string; indexPath: string } | undefined {
  if (platform() !== "win32") return undefined;

  const lower = resolvedPath.toLowerCase();
  const looksLikeLauncher =
    lower.endsWith("agent.cmd") ||
    lower.endsWith("agent.ps1") ||
    lower.endsWith("cursor-agent.cmd") ||
    lower.endsWith("cursor-agent.ps1") ||
    lower.endsWith("\\agent") ||
    lower.endsWith("/agent");

  if (!looksLikeLauncher && !/[\\/]cursor-agent[\\/]/i.test(resolvedPath)) {
    return undefined;
  }

  let installDir = dirname(resolvedPath);
  // where.exe may return ...\cursor-agent\agent.cmd — versions live beside it.
  if (!existsSync(join(installDir, "versions"))) {
    const parent = dirname(installDir);
    if (existsSync(join(parent, "versions"))) installDir = parent;
  }

  const versionsDir = join(installDir, "versions");
  if (!existsSync(versionsDir)) return undefined;

  const versionRe = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i;
  const versions = readdirSync(versionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && versionRe.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => versionSortKey(b) - versionSortKey(a));

  for (const name of versions) {
    const nodePath = join(versionsDir, name, "node.exe");
    const indexPath = join(versionsDir, name, "index.js");
    if (existsSync(nodePath) && existsSync(indexPath)) {
      return { nodePath, indexPath };
    }
  }
  return undefined;
}

/** Match cursor-agent.ps1: YYYY.MM.DD → sortable int (ignores optional time + hash). */
function versionSortKey(versionString: string): number {
  const datePart = versionString.split("-")[0] ?? "";
  const parts = datePart.split(".");
  if (parts.length !== 3) return 0;
  const year = parts[0] ?? "0";
  const month = (parts[1] ?? "0").padStart(2, "0");
  const day = (parts[2] ?? "0").padStart(2, "0");
  return Number(year + month + day) || 0;
}

/** Resolve how to spawn `agent acp` with a reliable stdin pipe. */
export function resolveAcpSpawnTarget(agentCliPath: string): AcpSpawnTarget {
  const resolved = resolveAgentCliPath(agentCliPath);
  const unwrapped = unwrapWindowsAgentLauncher(resolved);
  if (unwrapped) {
    return {
      command: unwrapped.nodePath,
      args: [unwrapped.indexPath, "acp"],
      shell: false,
      displayPath: unwrapped.indexPath,
    };
  }

  if (platform() === "win32") {
    const needsShell =
      !/[\\/]/.test(resolved) ||
      resolved.endsWith(".cmd") ||
      resolved.endsWith(".bat") ||
      resolved.endsWith(".ps1");
    return {
      command: resolved,
      args: ["acp"],
      shell: needsShell,
      displayPath: resolved,
    };
  }

  return {
    command: resolved,
    args: ["acp"],
    shell: false,
    displayPath: resolved,
  };
}

/** @deprecated Prefer resolveAcpSpawnTarget — kept for existing unit tests. */
export function acpSpawnOptions(resolvedPath: string): { shell: boolean } {
  if (platform() !== "win32") return { shell: false };
  const needsShell =
    !/[\\/]/.test(resolvedPath) ||
    resolvedPath.endsWith(".cmd") ||
    resolvedPath.endsWith(".bat");
  return { shell: needsShell };
}

/** Env keys that must never reach the Cursor ACP child process. */
const ACP_STRIP_ENV_KEYS = new Set([
  "TELEGRAM_BOT_TOKEN",
  "BOT_TOKEN",
  "TG_BOT_TOKEN",
  "TELEGRAM_TOKEN",
]);

/**
 * Build the environment for `agent acp`.
 * Keeps CURSOR_API_KEY (set from config) but strips Telegram bot tokens so a
 * compromised or curious agent cannot read them from `process.env`.
 */
export function buildAcpEnv(
  baseEnv: NodeJS.ProcessEnv,
  apiKey?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of ACP_STRIP_ENV_KEYS) {
    delete env[key];
  }
  // Also drop any env var whose value looks like a BotFather token.
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && /^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(value)) {
      delete env[key];
    }
  }
  if (apiKey) {
    env.CURSOR_API_KEY = apiKey;
  }
  return env;
}

/** Spawns `agent acp` and exposes stdin/stdout as line transport. */
export class AcpProcess implements LineTransport {
  private proc?: ChildProcessWithoutNullStreams;
  private rl?: readline.Interface;
  private lineHandler?: (line: string) => void;
  private startError?: Error;
  private exitError?: Error;
  private readonly target: AcpSpawnTarget;

  constructor(private readonly opts: AcpProcessOptions) {
    this.target = resolveAcpSpawnTarget(opts.agentCliPath);
  }

  /** True when the child is still alive and stdin accepts writes. */
  get alive(): boolean {
    return !!this.proc && !this.exitError && !!this.proc.stdin.writable;
  }

  async start(): Promise<void> {
    const env = buildAcpEnv(process.env, this.opts.apiKey);
    let settled = false;
    let stderrBuf = "";

    await new Promise<void>((resolve, reject) => {
      logger.info(
        {
          agentCliPath: this.opts.agentCliPath,
          command: this.target.command,
          displayPath: this.target.displayPath,
          shell: this.target.shell,
        },
        "starting ACP process",
      );

      this.proc = spawn(this.target.command, this.target.args, {
        cwd: this.opts.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: this.target.shell,
        windowsHide: true,
      });

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.startError = err;
        reject(err);
      };

      this.proc.on("error", (err) => {
        logger.error(
          {
            err: err.message,
            agentCliPath: this.opts.agentCliPath,
            command: this.target.command,
            displayPath: this.target.displayPath,
            shell: this.target.shell,
          },
          "acp process error",
        );
        fail(
          new Error(
            `Failed to start the ACP CLI (${this.target.displayPath}): ${err.message}. ` +
              "Set cursor.agentCliPath to the full path of agent.cmd.",
          ),
        );
      });

      this.proc.on("spawn", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      this.proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().slice(0, 500);
        stderrBuf += text;
        logger.warn({ stderr: text }, "acp stderr");
      });

      this.proc.on("exit", (code, signal) => {
        const detail =
          stderrBuf.trim() ||
          "Check cursor.agentCliPath, CURSOR_API_KEY, and that the Cursor agent CLI is installed.";
        const err = new Error(
          `ACP CLI exited (code=${code ?? "null"}, signal=${signal ?? "null"}). ${detail}`,
        );
        this.exitError = err;
        if (code !== null && code !== 0) {
          logger.warn(
            { code, signal, stderr: stderrBuf.slice(0, 200) },
            "acp process exited",
          );
          if (!settled) fail(err);
        } else {
          logger.warn(
            { code, signal, stderr: stderrBuf.slice(0, 200) },
            "acp process exited",
          );
        }
      });

      this.rl = readline.createInterface({ input: this.proc.stdout });
      this.rl.on("line", (line) => {
        this.lineHandler?.(line);
      });
    });
  }

  write(line: string): void {
    if (this.startError) {
      throw this.startError;
    }
    if (this.exitError) {
      throw this.exitError;
    }
    if (!this.proc?.stdin.writable) {
      throw new Error(
        "ACP process stdin not writable (agent CLI process is not running). " +
          "Try /reset, restart Cursor Supervisor, and confirm `agent acp` works in a terminal.",
      );
    }
    this.proc.stdin.write(`${line}\n`);
  }

  onLine(handler: (line: string) => void): () => void {
    this.lineHandler = handler;
    return () => {
      if (this.lineHandler === handler) this.lineHandler = undefined;
    };
  }

  async close(): Promise<void> {
    this.rl?.close();
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        this.proc!.once("exit", () => resolve());
        setTimeout(() => {
          if (!this.proc?.killed) this.proc?.kill("SIGKILL");
          resolve();
        }, 5000);
      });
    }
    this.proc = undefined;
  }
}
