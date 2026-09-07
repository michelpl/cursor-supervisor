import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ServiceLock,
  ServiceAlreadyRunningError,
  serviceLockPath,
} from "../../src/core/service/ServiceLock.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "svc-lock-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ServiceLock", () => {
  it("acquire writes service.json with current pid", async () => {
    const lock = new ServiceLock(dir);
    const record = await lock.acquire({
      configPath: "/tmp/config.json",
      cwd: "/tmp/ws",
      startedBy: "cli",
    });
    expect(record.pid).toBe(process.pid);
    expect(record.startedAt).toMatch(/^\d{4}-/);
    const onDisk = JSON.parse(await readFile(serviceLockPath(dir), "utf8"));
    expect(onDisk.pid).toBe(process.pid);
  });

  it("readStatus reports running when pid is alive", async () => {
    const lock = new ServiceLock(dir);
    await lock.acquire({
      configPath: "cfg.json",
      cwd: process.cwd(),
      startedBy: "cli",
    });
    const status = await lock.readStatus();
    expect(status.running).toBe(true);
    expect(status.stale).toBe(false);
    expect(status.pid).toBe(process.pid);
  });

  it("release removes lock file", async () => {
    const lock = new ServiceLock(dir);
    await lock.acquire({
      configPath: "cfg.json",
      cwd: process.cwd(),
      startedBy: "cli",
    });
    await lock.release();
    const status = await lock.readStatus();
    expect(status.running).toBe(false);
  });

  it("acquire fails when another live pid holds lock", async () => {
    const lock = new ServiceLock(dir);
    await lock.acquire({
      configPath: "cfg.json",
      cwd: process.cwd(),
      startedBy: "cli",
    });

    const lock2 = new ServiceLock(dir);
    await expect(
      lock2.acquire({
        configPath: "cfg.json",
        cwd: process.cwd(),
        startedBy: "extension",
      }),
    ).rejects.toBeInstanceOf(ServiceAlreadyRunningError);
  });

  it("updateControl writes port and token", async () => {
    const lock = new ServiceLock(dir);
    await lock.acquire({
      configPath: "cfg.json",
      cwd: process.cwd(),
      startedBy: "cli",
    });
    await lock.updateControl({ controlPort: 41234, controlToken: "tok" });
    const status = await lock.readStatus();
    expect(status.record?.controlPort).toBe(41234);
    expect(status.record?.controlToken).toBe("tok");
  });
});
