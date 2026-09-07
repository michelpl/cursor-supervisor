import { describe, it, expect } from "vitest";
import { InteractionRouter } from "../../src/core/interactions/InteractionRouter.js";
import { PendingInteractionStore } from "../../src/core/interactions/PendingInteractionStore.js";

function makeStore(): PendingInteractionStore {
  return new PendingInteractionStore({ timeoutMs: 60_000 });
}

describe("InteractionRouter.routeCallback", () => {
  it("resolves permission allow-once", () => {
    const store = makeStore();
    store.register({
      interactionId: "i-1",
      chatId: "42",
      workspaceId: "ws",
      kind: "permission",
    });
    const router = new InteractionRouter(store);
    expect(router.routeCallback("42", "acp:i-1:allow-once")).toEqual({
      action: "respond",
      interactionId: "i-1",
      response: { kind: "permission", optionId: "allow-once" },
    });
  });

  it("accepts dynamic optionIds when allow-listed", () => {
    const store = makeStore();
    store.register({
      interactionId: "i-1",
      chatId: "42",
      workspaceId: "ws",
      kind: "permission",
      allowedOptionIds: ["allow-once", "reject-always"],
    });
    const router = new InteractionRouter(store);
    expect(router.routeCallback("42", "acp:i-1:reject-always")).toEqual({
      action: "respond",
      interactionId: "i-1",
      response: { kind: "permission", optionId: "reject-always" },
    });
    expect(router.routeCallback("42", "acp:i-1:allow-always")).toBeUndefined();
  });

  it("ignores stale permission button for a different interaction id", () => {
    const store = makeStore();
    store.register({
      interactionId: "i-2",
      chatId: "42",
      workspaceId: "ws",
      kind: "permission",
    });
    const router = new InteractionRouter(store);
    expect(router.routeCallback("42", "acp:i-1:allow-once")).toBeUndefined();
  });

  it("answers single-select question on option tap", () => {
    const store = makeStore();
    store.register({
      interactionId: "i-1",
      chatId: "42",
      workspaceId: "ws",
      kind: "question",
      allowMultiple: false,
    });
    const router = new InteractionRouter(store);
    expect(router.routeCallback("42", "acp:i-1:select:q1:optA")).toEqual({
      action: "respond",
      interactionId: "i-1",
      response: { kind: "question", answers: { q1: ["optA"] } },
    });
  });

  it("acks multi-select option and responds on done", () => {
    const store = makeStore();
    store.register({
      interactionId: "i-1",
      chatId: "42",
      workspaceId: "ws",
      kind: "question",
      allowMultiple: true,
    });
    const router = new InteractionRouter(store);
    expect(router.routeCallback("42", "acp:i-1:select:q1:optA")).toEqual({
      action: "ack",
      interactionId: "i-1",
    });
    expect(store.get("i-1")?.partialAnswers).toEqual({ q1: ["optA"] });
    expect(router.routeCallback("42", "acp:i-1:done")).toEqual({
      action: "respond",
      interactionId: "i-1",
      response: { kind: "question", answers: { q1: ["optA"] } },
    });
  });

  it("resolves plan approve-save and reject", () => {
    const store = makeStore();
    store.register({
      interactionId: "i-1",
      chatId: "42",
      workspaceId: "ws",
      kind: "plan",
      planData: { plan: "# plan" },
    });
    const router = new InteractionRouter(store);
    expect(router.routeCallback("42", "acp:i-1:approve-save")).toEqual({
      action: "respond",
      interactionId: "i-1",
      response: { kind: "plan", accepted: true, save: true },
    });
  });
});
