import { join } from "node:path";
import { JsonStore } from "../persist/jsonStore.js";
import { z } from "zod";
import type { RuntimeInteractionResponse } from "../orchestrator/runtime.js";

export type PendingInteractionKind = "permission" | "question" | "plan";

export interface PendingPlanData {
  name?: string;
  overview?: string;
  plan: string;
  todos?: Array<{ id: string; content: string; status: string }>;
}

export interface PendingInteraction {
  interactionId: string;
  chatId: string;
  workspaceId: string;
  kind: PendingInteractionKind;
  createdAt: number;
  expiresAt: number;
  /** Allowed ACP optionIds for permission buttons */
  allowedOptionIds?: string[];
  /** For multi-select questions: accumulated option ids per question */
  partialAnswers?: Record<string, string[]>;
  /** When true, option taps accumulate until Confirm; otherwise one tap answers. */
  allowMultiple?: boolean;
  /** Plan payload for approve-save flow */
  planData?: PendingPlanData;
}

interface InteractionFile {
  items: PendingInteraction[];
}

const PendingInteractionSchema = z.object({
  interactionId: z.string(),
  chatId: z.string(),
  workspaceId: z.string(),
  kind: z.enum(["permission", "question", "plan"]),
  createdAt: z.number(),
  expiresAt: z.number(),
  allowedOptionIds: z.array(z.string()).optional(),
  partialAnswers: z.record(z.array(z.string())).optional(),
  allowMultiple: z.boolean().optional(),
  planData: z
    .object({
      name: z.string().optional(),
      overview: z.string().optional(),
      plan: z.string(),
      todos: z
        .array(
          z.object({
            id: z.string(),
            content: z.string(),
            status: z.string(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const InteractionFileSchema = z.object({
  items: z.array(PendingInteractionSchema),
});

export class PendingInteractionStore {
  private readonly byId = new Map<string, PendingInteraction>();
  private readonly byChat = new Map<string, string>();
  private readonly store?: JsonStore<InteractionFile>;
  private persistTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly opts: {
      dataDir?: string;
      timeoutMs: number;
      now?: () => number;
      onTimeout?: (item: PendingInteraction) => void;
    },
  ) {
    if (opts.dataDir) {
      this.store = new JsonStore<InteractionFile>(
        join(opts.dataDir, "interactions.json"),
        { items: [] },
        (raw) => InteractionFileSchema.parse(raw),
      );
    }
  }

  async init(): Promise<void> {
    if (!this.store) return;
    const file = await this.store.readOrInit();
    const now = this.now();
    for (const item of file.items) {
      if (item.expiresAt <= now) continue;
      this.byId.set(item.interactionId, item);
      this.byChat.set(item.chatId, item.interactionId);
    }
    this.persistTimer = setInterval(() => this.evictExpired(), 30_000);
  }

  dispose(): void {
    if (this.persistTimer) clearInterval(this.persistTimer);
  }

  register(input: Omit<PendingInteraction, "createdAt" | "expiresAt">): PendingInteraction {
    const now = this.now();
    const item: PendingInteraction = {
      ...input,
      createdAt: now,
      expiresAt: now + this.opts.timeoutMs,
    };
    this.byId.set(item.interactionId, item);
    this.byChat.set(item.chatId, item.interactionId);
    void this.persist();
    return item;
  }

  get(interactionId: string): PendingInteraction | undefined {
    return this.byId.get(interactionId);
  }

  getByChatId(chatId: string): PendingInteraction | undefined {
    const id = this.byChat.get(chatId);
    return id ? this.byId.get(id) : undefined;
  }

  hasPending(chatId: string): boolean {
    const item = this.getByChatId(chatId);
    return !!item && item.expiresAt > this.now();
  }

  async remove(interactionId: string): Promise<void> {
    const item = this.byId.get(interactionId);
    if (item) {
      this.byId.delete(interactionId);
      if (this.byChat.get(item.chatId) === interactionId) {
        this.byChat.delete(item.chatId);
      }
    }
    await this.persist();
  }

  /** Persist in-memory partial answers for multi-select without changing expiry. */
  async persistPartial(
    interactionId: string,
    partialAnswers: Record<string, string[]>,
  ): Promise<void> {
    const item = this.byId.get(interactionId);
    if (!item) return;
    item.partialAnswers = partialAnswers;
    await this.persist();
  }

  clearForChat(chatId: string): void {
    const id = this.byChat.get(chatId);
    if (id) void this.remove(id);
  }

  clearAll(): void {
    this.byId.clear();
    this.byChat.clear();
    void this.persist();
  }

  /** Register timeout handler after orchestrator is constructed. */
  setOnTimeout(handler: (item: PendingInteraction) => void): void {
    this.opts.onTimeout = handler;
  }

  /** Default auto-reject response when interaction times out. */
  defaultTimeoutResponse(kind: PendingInteractionKind): RuntimeInteractionResponse {
    switch (kind) {
      case "permission":
        return { kind: "permission", optionId: "reject-once" };
      case "question":
        return { kind: "question", answers: {} };
      case "plan":
        return { kind: "plan", accepted: false };
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [id, item] of this.byId) {
      if (item.expiresAt <= now) {
        this.opts.onTimeout?.(item);
        void this.remove(id);
      }
    }
  }

  private async persist(): Promise<void> {
    if (!this.store) return;
    await this.store.write({ items: [...this.byId.values()] });
  }
}
