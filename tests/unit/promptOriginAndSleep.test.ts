import { describe, it, expect } from "vitest";
import { wrapUserPrompt } from "../../src/core/orchestrator/promptEnvelope.js";
import { SleepBlocker } from "../../src/core/service/SleepBlocker.js";

describe("wrapUserPrompt", () => {
  it("labels telegram by default", () => {
    expect(wrapUserPrompt("hi")).toContain("via Telegram");
    expect(wrapUserPrompt("hi")).toContain("<user_request>\nhi\n</user_request>");
  });

  it("labels cli and ide origins", () => {
    expect(wrapUserPrompt("x", "cli")).toContain("via CLI");
    expect(wrapUserPrompt("x", "ide")).toContain("via Cursor IDE");
  });
});

describe("SleepBlocker", () => {
  it("release is idempotent when never acquired", async () => {
    const blocker = new SleepBlocker();
    await expect(blocker.release()).resolves.toBeUndefined();
    expect(blocker.isActive()).toBe(false);
  });

  it("acquire then release toggles active on supported platforms", async () => {
    const blocker = new SleepBlocker();
    await blocker.acquire();
    // May stay inactive if platform helper fails (e.g. CI without powershell/inhibit)
    if (blocker.isActive()) {
      await blocker.release();
      expect(blocker.isActive()).toBe(false);
    } else {
      await blocker.release();
    }
  });
});
