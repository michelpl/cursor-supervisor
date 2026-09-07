import type { PendingInteractionStore } from "./PendingInteractionStore.js";
import type { RuntimeInteractionResponse } from "../orchestrator/runtime.js";

export type RouteResult =
  | { action: "prompt" }
  | {
      action: "respond";
      interactionId: string;
      response: RuntimeInteractionResponse;
    }
  | {
      /** Multi-select option tapped; keep waiting for Confirm. */
      action: "ack";
      interactionId: string;
    };

/**
 * Decides whether an incoming Telegram message is a new prompt or a response
 * to a pending ACP interaction (open-ended question text).
 */
export class InteractionRouter {
  constructor(private readonly store: PendingInteractionStore) {}

  hasPending(chatId: string): boolean {
    return this.store.hasPending(chatId);
  }

  routeText(chatId: string, text: string): RouteResult {
    const pending = this.store.getByChatId(chatId);
    if (!pending) return { action: "prompt" };
    // Open-ended questions: free text reply
    if (pending.kind === "question") {
      return {
        action: "respond",
        interactionId: pending.interactionId,
        response: {
          kind: "question",
          answers: { freeform: [text] },
        },
      };
    }
    return { action: "prompt" };
  }

  routeCallback(
    chatId: string,
    callbackData: string,
  ): RouteResult | undefined {
    const pending = this.store.getByChatId(chatId);
    if (!pending) return undefined;

    const parts = callbackData.split(":");
    if (parts[0] !== "acp" || parts[1] !== pending.interactionId) return undefined;

    const action = parts[2];
    switch (pending.kind) {
      case "permission": {
        // optionId may contain colons — take everything after interactionId
        const optionId = parts.slice(2).join(":");
        if (!optionId) return undefined;
        const allowed = pending.allowedOptionIds;
        if (allowed && allowed.length > 0 && !allowed.includes(optionId)) {
          return undefined;
        }
        if (
          !allowed?.length &&
          !["allow-once", "allow-always", "reject-once", "reject-always"].includes(
            optionId,
          )
        ) {
          return undefined;
        }
        return {
          action: "respond",
          interactionId: pending.interactionId,
          response: { kind: "permission", optionId },
        };
      }
      case "question": {
        if (action === "done") {
          return {
            action: "respond",
            interactionId: pending.interactionId,
            response: {
              kind: "question",
              answers: pending.partialAnswers ?? {},
            },
          };
        }
        if (action !== "select") return undefined;
        const questionId = parts[3];
        const optionId = parts[4];
        if (!questionId || !optionId) return undefined;

        const partial = { ...(pending.partialAnswers ?? {}) };
        if (pending.allowMultiple) {
          const existing = partial[questionId] ?? [];
          if (!existing.includes(optionId)) {
            partial[questionId] = [...existing, optionId];
          }
          pending.partialAnswers = partial;
          void this.store.persistPartial(pending.interactionId, partial);
          return {
            action: "ack",
            interactionId: pending.interactionId,
          };
        }

        partial[questionId] = [optionId];
        return {
          action: "respond",
          interactionId: pending.interactionId,
          response: { kind: "question", answers: partial },
        };
      }
      case "plan": {
        if (action === "approve-save") {
          return {
            action: "respond",
            interactionId: pending.interactionId,
            response: { kind: "plan", accepted: true, save: true },
          };
        }
        if (action === "reject") {
          return {
            action: "respond",
            interactionId: pending.interactionId,
            response: { kind: "plan", accepted: false },
          };
        }
        return undefined;
      }
    }
  }
}
