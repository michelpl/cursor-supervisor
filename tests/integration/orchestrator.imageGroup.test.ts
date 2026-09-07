import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentOrchestrator } from "../../src/core/orchestrator/AgentOrchestrator.js";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";
import { SessionStore } from "../../src/core/session/SessionStore.js";
import { AttachmentQueue } from "../../src/core/attachments/AttachmentQueue.js";
import { AttachmentDispatcher } from "../../src/core/attachments/AttachmentDispatcher.js";
import { StubMessenger } from "../helpers/StubMessenger.js";
import { StubAgentRuntime } from "../helpers/StubAgent.js";
import { makeInteractionStore } from "../helpers/makeInteractionStore.js";
import { makeApprovedPlanStore } from "../helpers/makeApprovedPlanStore.js";
import type { ApprovedPlanStore } from "../../src/core/plans/ApprovedPlanStore.js";

// text
async function waitFor<T>(fn: () => T | undefined, retries = 200): Promise<T> {
  for (let i = 0; i < retries; i++) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timeout");
}

describe("AgentOrchestrator.runPromptWithImages", () => {
  let dataDir: string;
  let messenger: StubMessenger;
  let registry: WorkspaceRegistry;
  let session: SessionStore;
  let runtime: StubAgentRuntime;
  let orch: AgentOrchestrator;
  let approvedPlanStore: ApprovedPlanStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ig-orch-"));
    messenger = new StubMessenger();
    registry = new WorkspaceRegistry(join(dataDir, "ws.json"));
    await registry.init({ autoRegisterCwd: true, cwd: dataDir });
    session = new SessionStore(join(dataDir, "sess.json"));
    await session.init();
    runtime = new StubAgentRuntime();
    const interactionStore = await makeInteractionStore();
    ({ store: approvedPlanStore } = await makeApprovedPlanStore(dataDir));
    orch = new AgentOrchestrator({
      messenger,
      runtime,
      registry,
      session,
      streamOptions: { throttleMs: 1, maxLen: 1000 },
      acpMode: "agent",
      interactionStore,
      approvedPlanStore,
    });
  });

  afterEach(async () => {
    await orch.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("text images text agent.sendtext", async () => {
    // text M1 text runtext stub text
    const p = orch.runPromptWithImages({
      chatId: "1",
      text: "text",
      images: [{ data: "AAA=", mimeType: "image/jpeg" }],
      force: false,
      userId: 0,
    });
    const agent = await waitFor(() => runtime.agents[0]);
    const run = await waitFor(() => agent.currentRun);
    run.setScript([{ type: "assistant", text: "text" }]);
    await p;

    // texttext + images
    expect(agent.lastSend?.text).toContain("<user_request>");
    expect(agent.lastSend?.text).toContain("text");
    expect(agent.lastSend?.images).toEqual([
      { data: "AAA=", mimeType: "image/jpeg" },
    ]);
    expect(agent.lastSend?.force).toBe(false);
  });

  it("text + text force=false", async () => {
    const p = orch.runPromptWithImages({
      chatId: "1",
      text: "text",
      images: [
        { data: "A", mimeType: "image/png" },
        { data: "B", mimeType: "image/png" },
        { data: "C", mimeType: "image/png" },
      ],
      force: false,
      userId: 0,
    });
    const agent = await waitFor(() => runtime.agents[0]);
    const run = await waitFor(() => agent.currentRun);
    run.setScript([{ type: "assistant", text: "x" }]);
    await p;

    expect(agent.lastSend?.images?.length).toBe(3);
    expect(agent.lastSend?.force).toBe(false);
  });

  it("run text dispatcher text", async () => {
    const queuePath = join(dataDir, "queue.jsonl");
    const pendingDir = join(dataDir, "pending");
    await mkdir(pendingDir, { recursive: true });
    const f = join(pendingDir, "x.png");
    await writeFile(f, Buffer.from([1]));
    const queue = new AttachmentQueue(queuePath);
    const ws = registry.getActive()!;
    await queue.append({
      cwd: ws.path,
      kind: "image",
      path: f,
      queuedAt: 1,
    });
    const dispatcher = new AttachmentDispatcher({
      queue,
      messenger,
      maxRetries: 3,
      maxPerFlush: 10,
      pendingRoot: pendingDir,
    });
    const interactionStore2 = await makeInteractionStore();
    const orch2 = new AgentOrchestrator({
      messenger,
      runtime,
      registry,
      session,
      streamOptions: { throttleMs: 1, maxLen: 1000 },
      acpMode: "agent",
      interactionStore: interactionStore2,
      attachmentDispatcher: dispatcher,
      approvedPlanStore,
    });
    const p = orch2.runPrompt({ chatId: "1", text: "hi", force: false, userId: 0 });
    const agent = await waitFor(() => runtime.agents[0]);
    const run = await waitFor(() => agent.currentRun);
    run.setScript([{ type: "assistant", text: "ok" }]);
    await p;
    expect(messenger.sentImages.length).toBe(1);
    expect((await queue.readAll()).length).toBe(0);
    await orch2.dispose();
  });

  describe("runReminder", () => {
    it("kind=text text sendText", async () => {
      const r = await orch.runReminder({
        chatId: "1",
        kind: "text",
        text: "text",
        userId: 0,
      });
      expect(r.delivered).toBe(true);
      expect(
        messenger.sentTexts.some((t) => t.text.includes("Reminder")),
      ).toBe(true);
    });

    it("kind=prompt text send", async () => {
      const p = orch.runReminder({
        chatId: "1",
        kind: "prompt",
        prompt: "text BTC text",
        userId: 0,
      });
      const agent = await waitFor(() => runtime.agents[0]);
      const run = await waitFor(() => agent.currentRun);
      run.setScript([{ type: "assistant", text: "text" }]);
      const r = await p;
      expect(r.delivered).toBe(true);
      expect(agent.lastSend?.text).toContain("<user_request>");
      expect(agent.lastSend?.text).toContain("text BTC text");
    });

    it("kind=prompt uses workspaceId and marks it active", async () => {
      const otherDir = join(dataDir, "other-ws");
      await mkdir(otherDir, { recursive: true });
      registry.add("other", otherDir);
      await registry.persist();
      expect(registry.getActive()?.name).toBe("default");

      const p = orch.runReminder({
        chatId: "1",
        kind: "prompt",
        prompt: "in other",
        workspaceId: "other",
        userId: 0,
      });
      const agent = await waitFor(() => runtime.agents[0]);
      const run = await waitFor(() => agent.currentRun);
      run.setScript([{ type: "assistant", text: "ok" }]);
      const r = await p;
      expect(r.delivered).toBe(true);
      expect(runtime.created[0]?.cwd).toBe(otherDir);
      expect(registry.getActive()?.name).toBe("other");
    });
  });

  it("text workspace text send", async () => {
    // text registry text orchestrator text
    const empty = new WorkspaceRegistry(join(dataDir, "empty.json"));
    await empty.init({ autoRegisterCwd: false, cwd: dataDir });
    const messenger2 = new StubMessenger();
    const runtime2 = new StubAgentRuntime();
    const interactionStore3 = await makeInteractionStore();
    const { store: planStore2 } = await makeApprovedPlanStore(dataDir);
    const orch2 = new AgentOrchestrator({
      messenger: messenger2,
      runtime: runtime2,
      registry: empty,
      session,
      streamOptions: { throttleMs: 1, maxLen: 1000 },
      acpMode: "agent",
      interactionStore: interactionStore3,
      approvedPlanStore: planStore2,
    });
    await orch2.runPromptWithImages({
      chatId: "1",
      text: "text",
      images: [{ data: "A", mimeType: "image/jpeg" }],
      force: false,
      userId: 0,
    });
    expect(runtime2.agents.length).toBe(0);
    expect(
      messenger2.sentTexts.some((m) => m.text.includes("workspace")),
    ).toBe(true);
    await orch2.dispose();
  });
});
