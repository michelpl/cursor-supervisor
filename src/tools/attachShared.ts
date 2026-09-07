// CLI text argv text text pending text append text queue.jsonltext
import {
  mkdir,
  copyFile,
  stat,
  readFile,
  appendFile,
  chmod,
  access,
} from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { defaultDataDir, DATA_DIR_ENV } from "../config/paths.js";

export type AttachKind = "image" | "file";

interface ParsedArgs {
  filePath: string;
  caption?: string;
  dataDirOverride?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new Error("usage: <file> [--caption <text>] [--data-dir <path>]");
  }
  let filePath: string | undefined;
  let caption: string | undefined;
  let dataDirOverride: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--caption") {
      caption = argv[++i];
    } else if (a === "--data-dir") {
      dataDirOverride = argv[++i];
    } else if (!filePath) {
      filePath = a;
    } else {
      throw new Error(`unexpected arg: ${a}`);
    }
  }
  if (!filePath) throw new Error("file path required");
  return { filePath: resolve(filePath), caption, dataDirOverride };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate data dir:
 * 1. --data-dir flag
 * 2. CURSOR_SUPERVISOR_DATA_DIR env
 * 3. walk cwd for .cursor-supervisor/data-dir.txt
 * 4. global ~/.cursor-supervisor/data (if it exists)
 */
async function locateDataDir(override?: string): Promise<string> {
  if (override) return resolve(override);
  if (process.env[DATA_DIR_ENV]) {
    return resolve(process.env[DATA_DIR_ENV]!);
  }
  let cur = process.cwd();
  for (let i = 0; i < 32; i++) {
    const marker = join(cur, ".cursor-supervisor", "data-dir.txt");
    try {
      const txt = (await readFile(marker, "utf8")).trim();
      if (txt) return resolve(txt);
    } catch {
      // keep walking
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const globalDir = defaultDataDir();
  if (await pathExists(globalDir)) return globalDir;
  throw new Error(
    `could not locate Cursor Supervisor data dir; set ${DATA_DIR_ENV}, run the service once, or create ${globalDir}`,
  );
}

export async function runAttach(
  kind: AttachKind,
  argv: string[],
): Promise<void> {
  const { filePath, caption, dataDirOverride } = parseArgs(argv);
  const dataDir = await locateDataDir(dataDirOverride);
  const st = await stat(filePath);
  if (!st.isFile()) throw new Error(`not a file: ${filePath}`);

  const pendingDir = join(dataDir, "attachments", "pending");
  await mkdir(pendingDir, { recursive: true, mode: 0o700 });
  const isoTs = new Date().toISOString().replace(/[:.]/g, "-");
  const destPath = join(pendingDir, `${isoTs}-${basename(filePath)}`);
  await copyFile(filePath, destPath);
  await chmod(destPath, 0o600);

  const entry = {
    cwd: process.cwd(),
    kind,
    path: destPath,
    caption,
    queuedAt: Date.now(),
  };
  const queuePath = join(dataDir, "attachments", "queue.jsonl");
  await appendFile(queuePath, JSON.stringify(entry) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  process.stdout.write(`queued: ${destPath}\n`);
}
