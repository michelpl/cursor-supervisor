import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../../logger.js";

export interface WhisperCppSttOptions {
  whisperCliPath: string;
  modelPath: string;
  ffmpegPath: string;
  language: string;
  timeoutMs: number;
  /** Optional override for tests. */
  spawnFn?: typeof spawn;
  /** Temp root (defaults to os.tmpdir()). */
  tempRoot?: string;
}

export interface SpeechToText {
  transcribe(input: Buffer, mimeHint?: string): Promise<string>;
}

/**
 * Local STT via ffmpeg (→ WAV 16 kHz mono) + whisper.cpp CLI.
 * Does not call any cloud LLM — only local compute.
 */
export class WhisperCppStt implements SpeechToText {
  private readonly spawnFn: typeof spawn;

  constructor(private readonly opts: WhisperCppSttOptions) {
    this.spawnFn = opts.spawnFn ?? spawn;
  }

  async transcribe(input: Buffer, _mimeHint?: string): Promise<string> {
    const base = this.opts.tempRoot ?? tmpdir();
    await mkdir(base, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(base, "cs-stt-"));
    const inPath = join(root, "in.ogg");
    const wavPath = join(root, "out.wav");
    try {
      await writeFile(inPath, input);
      await this.runFfmpeg(inPath, wavPath);
      const transcript = await this.runWhisper(wavPath);
      return transcript.trim();
    } finally {
      await rm(root, { recursive: true, force: true }).catch((e) => {
        logger.warn({ err: (e as Error).message, root }, "stt temp cleanup failed");
      });
    }
  }

  private runFfmpeg(inPath: string, wavPath: string): Promise<void> {
    return this.runProcess(
      this.opts.ffmpegPath,
      ["-y", "-i", inPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      "ffmpeg",
    ).then(() => undefined);
  }

  private async runWhisper(wavPath: string): Promise<string> {
    const { stdout } = await this.runProcess(
      this.opts.whisperCliPath,
      [
        "-m",
        this.opts.modelPath,
        "-f",
        wavPath,
        "-l",
        this.opts.language,
        "-nt",
      ],
      "whisper-cli",
    );
    // whisper-cli -nt prints the transcript; strip system banners if any.
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("whisper_") && !l.startsWith("system_info"));
    return lines.join(" ").trim();
  }

  private runProcess(
    command: string,
    args: string[],
    label: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${label} timed out after ${this.opts.timeoutMs}ms`));
      }, this.opts.timeoutMs);

      child.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`${label} failed to start: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          new Error(
            `${label} exited ${code}: ${(stderr || stdout).slice(0, 400)}`,
          ),
        );
      });
    });
  }
}

/** Ensure model file exists when voice STT is enabled. */
export async function assertVoiceSttReady(opts: {
  modelPath: string;
}): Promise<void> {
  try {
    await readFile(opts.modelPath);
  } catch {
    throw new Error(
      `voice.enabled is true but modelPath is missing or unreadable: ${opts.modelPath}`,
    );
  }
}
