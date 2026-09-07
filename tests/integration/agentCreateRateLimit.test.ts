import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator } from "../../src/core/orchestrator/AgentOrchestrator.js";
import { RateLimiter } from "../../src/core/rateLimit/RateLimiter.js";
import { PendingInteractionStore } from "../../src/core/interactions/PendingInteractionStore.js";
import { ApprovedPlanStore } from "../../src/core/plans/ApprovedPlanStore.js";
import type { OrchestratorDeps } from "../../src/core/orchestrator/AgentOrchestrator.js";

function makeFakeRuntime() {
  const created: string[] = [];
  return {
    created,
    create: vi.fn(async (opts: { cwd: string }) => {
      created.push(opts.cwd);
      return {
        sessionId: `s-${created.length}`,
        send: vi.fn(async () => ({
          stream: async function* () {},
          wait: async () => ({ status: "finished" as const, durationMs: 0 }),
          cancel: async () => {},
          respond: async () => {},
        })),
        dispose: vi.fn(async () => {}),
        setMode: vi.fn(async () => {}),
        getMode: vi.fn(() => "agent"),
        getAvailableModes: vi.fn(() => []),
      };
    }),
    resume: vi.fn(),
  };
}

function makeFakeMessenger() {
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    sent,
    sendText: vi.fn(async (chatId: string, text: string) => {
      sent.push({ chatId, text });
      return { messageId: `m-${sent.length}` };
    }),
    editText: vi.fn(async () => {}),
    sendDocument: vi.fn(async () => {}),
    sendImage: vi.fn(async () => ({ messageId: "img-1" })),
    sendTyping: vi.fn(async () => {}),
    sendInteractiveMessage: vi.fn(async () => ({ messageId: "i-1" })),
    answerCallbackQuery: vi.fn(async () => {}),
    clearInlineKeyboard: vi.fn(async () => {}),
  };
}

function makeFakeSession() {
  return {
    get: () => undefined,
    set: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
}

describe("AgentOrchestrator sessionCreate rate limit", () => {
  it("capacity=2 allows 2 creates then rate-limits", async () => {
    const runtime = makeFakeRuntime();
    const messenger = makeFakeMessenger();
    let activeWs: { name: string; path: string } = { name: "ws1", path: "/tmp/ws1" };
    const registry = { getActive: () => activeWs };
    const interactionStore = new PendingInteractionStore({ timeoutMs: 60_000 });
    await interactionStore.init();

    const limiter = new RateLimiter({
      buckets: { sessionCreate: { capacity: 2, refillPerSec: 0.0001 } },
      now: () => 0,
    });

    const approvedPlanStore = {
      get: () => undefined,
      set: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    } as unknown as ApprovedPlanStore;

    const deps: Partial<OrchestratorDeps> = {
      messenger: messenger as unknown as OrchestratorDeps["messenger"],
      runtime: runtime as unknown as OrchestratorDeps["runtime"],
      registry: registry as unknown as OrchestratorDeps["registry"],
      session: makeFakeSession() as unknown as OrchestratorDeps["session"],
      streamOptions: { throttleMs: 0, maxLen: 1000 },
      acpMode: "agent",
      rateLimiter: limiter,
      interactionStore,
      approvedPlanStore,
    };

    const orch = new AgentOrchestrator(deps as OrchestratorDeps);

    activeWs = { name: "ws1", path: "/tmp/ws1" };
    await orch.runPrompt({ chatId: "C", text: "hi", force: false, userId: 42 });
    activeWs = { name: "ws2", path: "/tmp/ws2" };
    await orch.runPrompt({ chatId: "C", text: "hi", force: false, userId: 42 });
    activeWs = { name: "ws3", path: "/tmp/ws3" };
    await orch.runPrompt({ chatId: "C", text: "hi", force: false, userId: 42 });

    expect(runtime.created).toEqual(["/tmp/ws1", "/tmp/ws2"]);
    expect(runtime.create).toHaveBeenCalledTimes(2);
    const last = messenger.sent[messenger.sent.length - 1]?.text ?? "";
    expect(last).toMatch(/session/i);
  });

  it("cached agent skips sessionCreate bucket", async () => {
    const runtime = makeFakeRuntime();
    const messenger = makeFakeMessenger();
    const registry = { getActive: () => ({ name: "ws1", path: "/tmp/ws1" }) };
    const interactionStore = new PendingInteractionStore({ timeoutMs: 60_000 });
    await interactionStore.init();

    const limiter = new RateLimiter({
      buckets: { sessionCreate: { capacity: 1, refillPerSec: 0.0001 } },
      now: () => 0,
    });

    const approvedPlanStore = {
      get: () => undefined,
      set: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    } as unknown as ApprovedPlanStore;

    const deps: Partial<OrchestratorDeps> = {
      messenger: messenger as unknown as OrchestratorDeps["messenger"],
      runtime: runtime as unknown as OrchestratorDeps["runtime"],
      registry: registry as unknown as OrchestratorDeps["registry"],
      session: makeFakeSession() as unknown as OrchestratorDeps["session"],
      streamOptions: { throttleMs: 0, maxLen: 1000 },
      acpMode: "agent",
      rateLimiter: limiter,
      interactionStore,
      approvedPlanStore,
    };

    const orch = new AgentOrchestrator(deps as OrchestratorDeps);

    for (let i = 0; i < 5; i++) {
      await orch.runPrompt({ chatId: "C", text: "hi", force: false, userId: 42 });
    }
    expect(runtime.create).toHaveBeenCalledTimes(1);
  });
});
