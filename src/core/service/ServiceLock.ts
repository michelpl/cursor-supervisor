import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { z } from "zod";
import { isProcessAlive } from "./processAlive.js";

export const ServiceRecordSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
  configPath: z.string().min(1),
  cwd: z.string().min(1),
  startedBy: z.enum(["cli", "extension"]).default("cli"),
  controlPort: z.number().int().positive().optional(),
  controlToken: z.string().min(1).optional(),
});

export type ServiceRecord = z.infer<typeof ServiceRecordSchema>;

export interface ServiceStatus {
  running: boolean;
  stale: boolean;
  record?: ServiceRecord;
  pid?: number;
}

export class ServiceAlreadyRunningError extends Error {
  constructor(
    public readonly record: ServiceRecord,
  ) {
    super(
      `Cursor Supervisor already running (pid ${record.pid}, since ${record.startedAt})`,
    );
    this.name = "ServiceAlreadyRunningError";
  }
}

export function serviceLockPath(dataDir: string): string {
  return join(dataDir, "service.json");
}

async function readRecord(filePath: string): Promise<ServiceRecord | null> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return ServiceRecordSchema.parse(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writeRecord(filePath: string, record: ServiceRecord): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, filePath);
}

export class ServiceLock {
  private readonly filePath: string;
  private acquired = false;

  constructor(dataDir: string) {
    this.filePath = serviceLockPath(dataDir);
  }

  async readStatus(): Promise<ServiceStatus> {
    const record = await readRecord(this.filePath);
    if (!record) return { running: false, stale: false };

    const alive = isProcessAlive(record.pid);
    return {
      running: alive,
      stale: !alive,
      record,
      pid: record.pid,
    };
  }

  async acquire(meta: Omit<ServiceRecord, "pid" | "startedAt">): Promise<ServiceRecord> {
    const status = await this.readStatus();
    if (status.running && status.record) {
      throw new ServiceAlreadyRunningError(status.record);
    }
    if (status.stale) {
      await this.release();
    }

    const record: ServiceRecord = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...meta,
    };
    await writeRecord(this.filePath, record);
    this.acquired = true;
    return record;
  }

  async updateControl(meta: {
    controlPort: number;
    controlToken: string;
  }): Promise<void> {
    const record = await readRecord(this.filePath);
    if (!record) {
      throw new Error("cannot update control endpoints: no service lock");
    }
    await writeRecord(this.filePath, { ...record, ...meta });
  }

  async release(): Promise<void> {
    this.acquired = false;
    try {
      await unlink(this.filePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  isAcquired(): boolean {
    return this.acquired;
  }
}
