import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../../logger.js";

const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;

/**
 * Prevents OS idle sleep/hibernation while the Supervisor service is running.
 * Display sleep is intentionally not blocked.
 */
export class SleepBlocker {
  private active = false;
  private child?: ChildProcess;
  private releaseWindows?: () => void;

  async acquire(): Promise<void> {
    if (this.active) return;
    try {
      if (process.platform === "win32") {
        await this.acquireWindows();
      } else if (process.platform === "darwin") {
        this.acquireDarwin();
      } else if (process.platform === "linux") {
        this.acquireLinux();
      } else {
        logger.warn({ platform: process.platform }, "SleepBlocker: unsupported platform");
        return;
      }
      this.active = true;
      logger.info({ platform: process.platform }, "SleepBlocker: sleep prevention active");
    } catch (e) {
      logger.warn(
        { err: (e as Error).message, platform: process.platform },
        "SleepBlocker: failed to prevent sleep (continuing)",
      );
    }
  }

  async release(): Promise<void> {
    if (!this.active && !this.child && !this.releaseWindows) return;
    try {
      if (this.releaseWindows) {
        this.releaseWindows();
        this.releaseWindows = undefined;
      }
      if (this.child) {
        const child = this.child;
        this.child = undefined;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
      logger.info("SleepBlocker: sleep prevention released");
    } catch (e) {
      logger.warn(
        { err: (e as Error).message },
        "SleepBlocker: failed to release (continuing)",
      );
    } finally {
      this.active = false;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  private async acquireWindows(): Promise<void> {
    // Hold via PowerShell P/Invoke (no native dep). Re-assert is not needed
    // while the process lives; ES_CONTINUOUS keeps the request until cleared.
    await runPowerShellSetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
    this.releaseWindows = () => {
      void runPowerShellSetThreadExecutionState(ES_CONTINUOUS).catch((err) => {
        logger.warn(
          { err: (err as Error).message },
          "SleepBlocker: PowerShell release failed",
        );
      });
    };
  }

  private acquireDarwin(): void {
    const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], {
      stdio: "ignore",
      detached: false,
    });
    child.on("error", (err) => {
      logger.warn({ err: err.message }, "SleepBlocker: caffeinate error");
      this.active = false;
    });
    this.child = child;
  }

  private acquireLinux(): void {
    const child = spawn(
      "systemd-inhibit",
      [
        "--what=idle:sleep",
        "--who=cursor-supervisor",
        "--why=Cursor Supervisor active",
        "--mode=block",
        "sleep",
        "infinity",
      ],
      { stdio: "ignore", detached: false },
    );
    child.on("error", (err) => {
      logger.warn(
        { err: err.message },
        "SleepBlocker: systemd-inhibit unavailable",
      );
      this.active = false;
    });
    this.child = child;
  }
}

function runPowerShellSetThreadExecutionState(flags: number): Promise<void> {
  const script = [
    "Add-Type -Namespace CS -Name Power -MemberDefinition @'",
    "[DllImport(\"kernel32.dll\")]",
    "public static extern uint SetThreadExecutionState(uint esFlags);",
    "'@ -ErrorAction SilentlyContinue",
    `$r = [CS.Power]::SetThreadExecutionState(${flags})`,
    "if ($r -eq 0) { exit 1 }",
  ].join("; ");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: "ignore", windowsHide: true },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell SetThreadExecutionState exited ${code}`));
    });
  });
}
