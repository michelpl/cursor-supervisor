import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubMessenger } from "../helpers/StubMessenger.js";
import { StubAgentRuntime } from "../helpers/StubAgent.js";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";
import { SessionStore } from "../../src/core/session/SessionStore.js";
import { AgentOrchestrator } from "../../src/core/orchestrator/AgentOrchestrator.js";
import { dispatchCommand } from "../../src/commands/dispatch.js";
import { makeInteractionStore } from "../helpers/makeInteractionStore.js";
import { makeApprovedPlanStore } from "../helpers/makeApprovedPlanStore.js";

let dir: string;
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup() {
  dir = await mkdtemp(join(tmpdir(), "cmd-"));
  const registry = new WorkspaceRegistry(join(dir, "workspaces.json"));
  await registry.init({ autoRegisterCwd: true, cwd: dir });
  const session = new SessionStore(join(dir, "sessions.json"));
  await session.init();
  const messenger = new StubMessenger();
  const runtime = new StubAgentRuntime();
  const interactionStore = await makeInteractionStore();
  const { store: approvedPlanStore } = await makeApprovedPlanStore(dir);
  const orch = new AgentOrchestrator({
    messenger,
    runtime,
    registry,
    session,
    streamOptions: { throttleMs: 5, maxLen: 1000 },
    acpMode: "agent",
    interactionStore,
    approvedPlanStore,
  });
  return { messenger, registry, session, orch, runtime };
}

function lastSent(messenger: StubMessenger): string {
  const sent = [...messenger.calls].reverse().find((c) => c.kind === "sendText");
  return sent && sent.kind === "sendText" ? sent.text : "";
}

describe("dispatchCommand", () => {
  it("/help returns command list", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      { type: "command", name: "help", args: [], rest: "" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(lastSent(messenger)).toContain("/start");
  });

  it("/wslist includes default workspace", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      { type: "command", name: "wslist", args: [], rest: "" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    const interactive = messenger.calls.find((c) => c.kind === "sendInteractive");
    expect(interactive?.kind).toBe("sendInteractive");
    if (interactive?.kind === "sendInteractive") {
      expect(interactive.msg.text).toContain("default");
      expect(interactive.msg.buttons.some((b) => b.id === "ws:use:default")).toBe(
        true,
      );
      expect(interactive.msg.buttons.some((b) => b.id === "ws:help:add")).toBe(
        true,
      );
    }
  });

  it("/wsadd registers workspace and makes it active", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      {
        type: "command",
        name: "wsadd",
        args: ["alpha", dir],
        rest: `alpha ${dir}`,
      },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(registry.get("alpha")?.path).toBe(dir);
    expect(registry.getActive()?.name).toBe("alpha");
    expect(lastSent(messenger)).toMatch(/added and active/i);
  });

  it("/ws use ghost returns not found", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      { type: "command", name: "ws", args: ["use", "ghost"], rest: "use ghost" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(lastSent(messenger)).toMatch(/not found/i);
  });

  it("/reset clears session for default workspace", async () => {
    const { messenger, registry, session, orch } = await setup();
    await session.set("default", { sessionId: "session-x" });
    await dispatchCommand(
      { type: "command", name: "reset", args: [], rest: "" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(session.get("default")?.sessionId).toBeUndefined();
  });

  it("/cancel acknowledges cancellation", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      { type: "command", name: "cancel", args: [], rest: "" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(lastSent(messenger)).toMatch(/cancel/i);
  });

  it("/status shows workspace name", async () => {
    const { messenger, registry, session, orch } = await setup();
    await session.set("default", { sessionId: "session-y" });
    await dispatchCommand(
      { type: "command", name: "status", args: [], rest: "" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(lastSent(messenger)).toContain("default");
  });

  it("/model is documented no-op with ACP", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      { type: "command", name: "model", args: ["composer-2"], rest: "composer-2" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(lastSent(messenger)).toMatch(/ACP/i);
  });

  it("unknown command hints /help", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      { type: "command", name: "nonexistent", args: [], rest: "" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(lastSent(messenger)).toMatch(/unknown|help/i);
  });
});
