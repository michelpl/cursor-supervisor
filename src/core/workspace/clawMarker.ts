import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { logger } from "../../logger.js";

/**
 * Write `<wsPath>/.cursor-supervisor/data-dir.txt` pointing at the service data dir.
 */
export async function writeClawMarker(
  wsPath: string,
  dataDir: string,
): Promise<void> {
  try {
    const markerDir = join(wsPath, ".cursor-supervisor");
    await mkdir(markerDir, { recursive: true, mode: 0o700 });
    const abs = resolve(dataDir);
    await writeFile(join(markerDir, "data-dir.txt"), abs, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (e) {
    logger.warn(
      { err: (e as Error).message, wsPath },
      "failed to write data-dir marker",
    );
  }
}
