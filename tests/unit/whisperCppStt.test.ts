import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { WhisperCppStt } from "../../src/core/stt/WhisperCppStt.js";
import type { ChildProcess } from "node:child_process";

function fakeSpawnSequence(
  responses: Array<{ code: number; stdout?: string; stderr?: string }>,
) {
  let i = 0;
  return vi.fn((_cmd: string, _args: string[]) => {
    const spec = responses[i++] ?? { code: 1, stderr: "unexpected spawn" };
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (child as { stdout: EventEmitter }).stdout = stdout;
    (child as { stderr: EventEmitter }).stderr = stderr;
    queueMicrotask(() => {
      if (spec.stdout) stdout.emit("data", Buffer.from(spec.stdout));
      if (spec.stderr) stderr.emit("data", Buffer.from(spec.stderr));
      child.emit("close", spec.code);
    });
    return child as unknown as ChildProcess;
  });
}

describe("WhisperCppStt", () => {
  it("runs ffmpeg then whisper-cli and returns transcript", async () => {
    const spawnFn = fakeSpawnSequence([
      { code: 0 },
      { code: 0, stdout: "hello from voice\n" },
    ]);
    const stt = new WhisperCppStt({
      whisperCliPath: "whisper-cli",
      modelPath: "model.bin",
      ffmpegPath: "ffmpeg",
      language: "pt",
      timeoutMs: 5_000,
      spawnFn: spawnFn as never,
    });
    const text = await stt.transcribe(Buffer.from("ogg-bytes"));
    expect(text).toBe("hello from voice");
    expect(spawnFn).toHaveBeenCalledTimes(2);
    const ffmpegArgs = spawnFn.mock.calls[0]![1] as string[];
    expect(ffmpegArgs).toContain("-ar");
    expect(ffmpegArgs).toContain("16000");
    const whisperArgs = spawnFn.mock.calls[1]![1] as string[];
    expect(whisperArgs).toContain("-m");
    expect(whisperArgs).toContain("model.bin");
    expect(whisperArgs).toContain("-nt");
  });

  it("rejects when whisper exits non-zero", async () => {
    const spawnFn = fakeSpawnSequence([
      { code: 0 },
      { code: 2, stderr: "model missing" },
    ]);
    const stt = new WhisperCppStt({
      whisperCliPath: "whisper-cli",
      modelPath: "model.bin",
      ffmpegPath: "ffmpeg",
      language: "en",
      timeoutMs: 5_000,
      spawnFn: spawnFn as never,
    });
    await expect(stt.transcribe(Buffer.from("x"))).rejects.toThrow(/whisper-cli exited 2/);
  });
});
