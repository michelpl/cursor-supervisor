import { logger } from "../../logger.js";
import type { IMessenger } from "../messenger/IMessenger.js";
import type { WorkspaceRegistry } from "../workspace/WorkspaceRegistry.js";
import type { SessionStore } from "../session/SessionStore.js";
import { StreamRenderer, type StreamRendererOptions } from "./streamRenderer.js";
import { summarizeTool } from "./toolSummary.js";
import { decideBusyAction, type RunStatus } from "./busyPolicy.js";
import type {
  IAgentRuntime,
  RuntimeAgent,
  RuntimeRun,
  RuntimeInteractionResponse,
  RuntimeStreamEvent,
  AcpMode,
} from "./runtime.js";
import type { AttachmentDispatcher } from "../attachments/AttachmentDispatcher.js";
import type { RateLimiter } from "../rateLimit/RateLimiter.js";
import { RateLimitedError } from "../rateLimit/errors.js";
import { rateLimitedSessionCreateText } from "../../util/rateLimitMessages.js";
import { wrapUserPrompt, type PromptOrigin } from "./promptEnvelope.js";
import type { PendingInteractionStore } from "../interactions/PendingInteractionStore.js";
import type { ApprovedPlanStore } from "../plans/ApprovedPlanStore.js";
import { escapeHtml } from "../../util/html.js";
import { sendLongHtmlText } from "../../util/sendLongText.js";

export interface OrchestratorDeps {
  messenger: IMessenger;
  runtime: IAgentRuntime;
  registry: WorkspaceRegistry;
  session: SessionStore;
  streamOptions: StreamRendererOptions;
  acpMode: "agent" | "plan" | "ask";
  attachmentDispatcher?: AttachmentDispatcher;
  rateLimiter?: RateLimiter;
  interactionStore: PendingInteractionStore;
  approvedPlanStore: ApprovedPlanStore;
}

interface PoolEntry {
  agent: RuntimeAgent;
  activeRun?: RuntimeRun;
  chatId?: string;
}

export class AgentOrchestrator {
  private readonly pool = new Map<string, PoolEntry>();

  constructor(private readonly deps: OrchestratorDeps) {}

  hasPendingInteraction(chatId: string): boolean {
    return this.deps.interactionStore.hasPending(chatId);
  }

  isRunning(chatId: string): boolean {
    for (const entry of this.pool.values()) {
      if (entry.chatId === chatId && entry.activeRun?.status === "running") {
        return true;
      }
    }
    return false;
  }

  async respondToInteraction(
    chatId: string,
    interactionId: string,
    response: RuntimeInteractionResponse,
  ): Promise<boolean> {
    const pending = this.deps.interactionStore.get(interactionId);
    if (!pending || pending.chatId !== chatId) return false;

    const entry = this.pool.get(pending.workspaceId);
    if (!entry?.activeRun) {
      // Agent is no longer waiting (run ended / timed out). Drop stale pending.
      await this.deps.interactionStore.remove(interactionId);
      logger.warn(
        { interactionId, workspaceId: pending.workspaceId },
        "no active run for interaction — cleared pending",
      );
      return false;
    }

    if (
      response.kind === "plan" &&
      response.accepted &&
      response.save &&
      pending.planData
    ) {
      await this.deps.approvedPlanStore.set(pending.workspaceId, {
        workspaceId: pending.workspaceId,
        chatId,
        name: pending.planData.name,
        overview: pending.planData.overview,
        plan: pending.planData.plan,
        todos: pending.planData.todos,
        approvedAt: Date.now(),
      });
      await this.deps.messenger.sendText(
        chatId,
        "Plan saved. Use `/agent <prompt>` to execute (e.g. `/agent execute the plan`).",
        { parseMode: "plain" },
      );
    }

    await entry.activeRun.respond(interactionId, response);
    await this.deps.interactionStore.remove(interactionId);
    return true;
  }

  async setSessionMode(input: {
    chatId: string;
    mode: AcpMode;
    userId: number;
  }): Promise<void> {
    const ws = this.deps.registry.getActive();
    if (!ws) {
      await this.deps.messenger.sendText(
        input.chatId,
        "No active workspace. Use /wsadd to register a repository.",
      );
      return;
    }
    const entry = await this.ensureAgent(ws.name, ws.path, input.userId);
    await entry.agent.setMode(input.mode);
  }

  getSessionStatus(): {
    mode?: string;
    hasApprovedPlan: boolean;
    approvedPlanName?: string;
  } | null {
    const ws = this.deps.registry.getActive();
    if (!ws) return null;
    const entry = this.pool.get(ws.name);
    const approved = this.deps.approvedPlanStore.get(ws.name);
    return {
      mode: entry?.agent.getMode(),
      hasApprovedPlan: !!approved,
      approvedPlanName: approved?.name,
    };
  }

  async runPrompt(input: {
    chatId: string;
    text: string;
    force: boolean;
    userId: number;
    mode?: AcpMode;
    origin?: PromptOrigin;
    workspaceId?: string;
  }): Promise<void> {
    await this.runInternal(input);
  }

  async runPromptWithImages(input: {
    chatId: string;
    text: string;
    force: boolean;
    images: Array<{ data: string; mimeType: string }>;
    userId: number;
    mode?: AcpMode;
    origin?: PromptOrigin;
  }): Promise<void> {
    await this.runInternal(input);
  }

  async runReminder(input: {
    chatId: string;
    kind: "text" | "prompt";
    text?: string;
    prompt?: string;
    workspaceId?: string;
    userId: number;
  }): Promise<{ delivered: boolean; busy?: boolean }> {
    if (input.kind === "text") {
      const text = input.text ?? "";
      await this.deps.messenger.sendText(input.chatId, `🔔 Reminder: ${text}`);
      return { delivered: true };
    }
    const ok = await this.runInternal({
      chatId: input.chatId,
      text: input.prompt ?? "",
      force: false,
      skipBusyMsg: true,
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
    return { delivered: ok, busy: !ok };
  }

  private async runInternal(input: {
    chatId: string;
    text: string;
    force: boolean;
    images?: Array<{ data: string; mimeType: string }>;
    skipBusyMsg?: boolean;
    userId: number;
    mode?: AcpMode;
    workspaceId?: string;
    origin?: PromptOrigin;
  }): Promise<boolean> {
    const ws =
      (input.workspaceId
        ? this.deps.registry.get(input.workspaceId)
        : undefined) ?? this.deps.registry.getActive();
    if (!ws) {
      await this.deps.messenger.sendText(
        input.chatId,
        "No active workspace. Use /wsadd to register a repository.",
      );
      return false;
    }
    const wsId = ws.name;

    if (this.deps.registry.getActive()?.name !== wsId) {
      this.deps.registry.use(wsId);
      await this.deps.registry.persist();
    }

    let entry: PoolEntry;
    try {
      entry = await this.ensureAgent(wsId, ws.path, input.userId);
    } catch (e) {
      if (e instanceof RateLimitedError) {
        logger.warn(
          { userId: input.userId, key: e.key, retryMs: e.retryAfterMs },
          "rate limited",
        );
        await this.deps.messenger.sendText(
          input.chatId,
          rateLimitedSessionCreateText(e.retryAfterMs),
          { parseMode: "plain" },
        );
        return false;
      }
      throw e;
    }

    if (input.mode) {
      await entry.agent.setMode(input.mode);
    }

    const action = decideBusyAction({
      activeRunStatus: entry.activeRun?.status as RunStatus | undefined,
      force: input.force,
      hasPendingInteraction: this.deps.interactionStore.hasPending(input.chatId),
    });

    if (action === "respond") {
      return false;
    }

    if (action === "reject") {
      if (!input.skipBusyMsg) {
        await this.deps.messenger.sendText(
          input.chatId,
          `Agent on <b>${escapeHtml(ws.name)}</b> is busy. Use /cancel or prefix with <code>!</code> to force.`,
          { parseMode: "HTML" },
        );
      }
      return false;
    }

    const renderer = new StreamRenderer(
      this.deps.messenger,
      input.chatId,
      this.deps.streamOptions,
    );
    const origin = input.origin ?? "telegram";
    const originSuffix =
      origin === "ide" ? " (IDE)" : origin === "cli" ? " (CLI)" : "";
    const runMode = input.mode ?? entry.agent.getMode();
    const statusLabel =
      runMode === "plan"
        ? `Drafting plan${originSuffix}...`
        : runMode === "ask"
          ? `Answering${originSuffix}...`
          : `Starting${originSuffix}...`;
    await renderer.start(statusLabel, `Cursor started${originSuffix}`);

    let run: RuntimeRun;
    try {
      run = await entry.agent.send(wrapUserPrompt(input.text, origin), {
        force: action === "force-replace",
        images: input.images,
      });
    } catch (e) {
      const msg = (e as Error).message;
      logger.error({ err: msg }, "agent.send failed");
      await renderer.finalize(`\nError: ${escapeHtml(msg.slice(0, 400))}`);
      return true;
    }
    entry.activeRun = run;
    entry.chatId = input.chatId;
    renderer.setStatus("Working...");

    try {
      for await (const event of run.stream()) {
        await this.handleStreamEvent(event, {
          chatId: input.chatId,
          workspaceId: wsId,
          renderer,
          run,
        });
      }
      const r = await run.wait();
      if (r.status === "cancelled") {
        renderer.recordActivity("⏹ Cancelled");
        await renderer.finalize("\n<i>(cancelled)</i>");
        await this.deps.messenger.sendText(input.chatId, "⏹ Run cancelled.");
      } else if (r.status === "error") {
        logger.error(
          { err: r.result, durationMs: r.durationMs },
          "run finished with error",
        );
        const tail = r.result
          ? `\nError: ${escapeHtml(r.result.slice(0, 400))}`
          : "\nUnknown error";
        renderer.recordActivity(
          `❌ Failed${r.durationMs ? ` after ${formatDuration(r.durationMs)}` : ""}`,
        );
        await renderer.finalize(tail);
        await this.deps.messenger.sendText(
          input.chatId,
          `❌ Failed${r.durationMs ? ` after ${formatDuration(r.durationMs)}` : ""}.`,
        );
      } else {
        renderer.recordActivity(
          `✅ Finished${r.durationMs ? ` in ${formatDuration(r.durationMs)}` : ""}`,
        );
        await renderer.finalize();
        const doneMsg =
          runMode === "plan"
            ? `📋 Plan complete${r.durationMs ? ` in ${formatDuration(r.durationMs)}` : ""}.`
            : runMode === "ask"
              ? `💬 Answer complete${r.durationMs ? ` in ${formatDuration(r.durationMs)}` : ""}.`
              : `✅ Run complete${r.durationMs ? ` in ${formatDuration(r.durationMs)}` : ""}.`;
        await this.deps.messenger.sendText(input.chatId, doneMsg);
      }
    } finally {
      if (entry.activeRun === run) {
        entry.activeRun = undefined;
        entry.chatId = undefined;
      }
      this.deps.interactionStore.clearForChat(input.chatId);
    }

    if (this.deps.attachmentDispatcher) {
      try {
        await this.deps.attachmentDispatcher.flushForCwd(ws.path, input.chatId);
      } catch (e) {
        logger.error(
          { err: (e as Error).message },
          "dispatcher.flushForCwd failed",
        );
      }
    }

    return true;
  }

  private async handleStreamEvent(
    event: RuntimeStreamEvent,
    ctx: {
      chatId: string;
      workspaceId: string;
      renderer: StreamRenderer;
      run: RuntimeRun;
    },
  ): Promise<void> {
    switch (event.type) {
      case "assistant":
        await ctx.renderer.pushText(event.text);
        break;
      case "thinking":
        ctx.renderer.setStatus("Analyzing...");
        break;
      case "tool_call":
        if (event.status === "running") {
          const summary = summarizeTool(event.name, event.args);
          ctx.renderer.recordActivity(`⚙️ ${summary}`);
          ctx.renderer.setStatus(`Running ${summary}`);
        } else if (event.status === "completed") {
          ctx.renderer.recordActivity(`✅ ${event.name} completed`);
          ctx.renderer.setStatus("Analyzing...");
        } else {
          ctx.renderer.recordActivity(`❌ ${event.name} failed`);
          ctx.renderer.setStatus(`${event.name} failed`);
        }
        break;
      case "permission_request":
        await this.handlePermissionRequest(event, ctx);
        break;
      case "question_request":
        await this.handleQuestionRequest(event, ctx);
        break;
      case "plan_request":
        await this.handlePlanRequest(event, ctx);
        break;
      case "notification":
        await this.handleNotification(event, ctx.chatId);
        break;
    }
  }

  private async handlePermissionRequest(
    event: Extract<RuntimeStreamEvent, { type: "permission_request" }>,
    ctx: { chatId: string; workspaceId: string },
  ): Promise<void> {
    const options =
      event.options && event.options.length > 0
        ? event.options
        : [
            { optionId: "allow-once", name: "Allow once" },
            { optionId: "allow-always", name: "Always allow" },
            { optionId: "reject-once", name: "Deny" },
          ];
    const summary = event.summary ?? event.tool ?? "tool";
    const command =
      event.detail ??
      (event.args && typeof event.args === "object"
        ? ((event.args as Record<string, unknown>).command as string | undefined)
        : undefined);

    this.deps.interactionStore.register({
      interactionId: event.interactionId,
      chatId: ctx.chatId,
      workspaceId: ctx.workspaceId,
      kind: "permission",
      allowedOptionIds: options.map((o) => o.optionId),
    });

    const isExecute =
      event.tool === "execute" ||
      event.tool === "shell" ||
      (typeof command === "string" && command.length > 0);

    if (isExecute && command) {
      const truncated =
        command.length > 3500 ? `${command.slice(0, 3500)}…` : command;
      await this.deps.messenger.sendText(
        ctx.chatId,
        "🔐 The agent wants to run a command — approve or deny below.",
      );
      await this.deps.messenger.sendInteractiveMessage(ctx.chatId, {
        text: `🔐 <b>Run command?</b>\n<pre>${escapeHtml(truncated)}</pre>`,
        parseMode: "HTML",
        buttons: options.map((o) => ({
          id: `acp:${event.interactionId}:${o.optionId}`,
          label: o.name,
        })),
      });
      return;
    }

    await this.deps.messenger.sendText(
      ctx.chatId,
      "🔐 The agent needs your permission to continue.",
    );
    await this.deps.messenger.sendInteractiveMessage(ctx.chatId, {
      text: `🔐 Permission requested:\n<b>${escapeHtml(summary)}</b>`,
      parseMode: "HTML",
      buttons: options.map((o) => ({
        id: `acp:${event.interactionId}:${o.optionId}`,
        label: o.name,
      })),
    });
  }

  private async handleQuestionRequest(
    event: Extract<RuntimeStreamEvent, { type: "question_request" }>,
    ctx: { chatId: string; workspaceId: string },
  ): Promise<void> {
    const q = event.questions[0];
    if (!q) return;
    this.deps.interactionStore.register({
      interactionId: event.interactionId,
      chatId: ctx.chatId,
      workspaceId: ctx.workspaceId,
      kind: "question",
      allowMultiple: !!q.allowMultiple,
    });
    const title = event.title ?? q.prompt;
    const buttons = q.options.map((o) => ({
      id: `acp:${event.interactionId}:select:${q.id}:${o.id}`,
      label: o.label,
    }));
    if (q.allowMultiple) {
      buttons.push({
        id: `acp:${event.interactionId}:done`,
        label: "Confirm selection",
      });
    }
    await this.deps.messenger.sendText(ctx.chatId, "❓ The agent asked a question — reply below.");
    await this.deps.messenger.sendInteractiveMessage(ctx.chatId, {
      text: `❓ ${escapeHtml(title)}`,
      parseMode: "HTML",
      buttons,
    });
  }

  private async handlePlanRequest(
    event: Extract<RuntimeStreamEvent, { type: "plan_request" }>,
    ctx: { chatId: string; workspaceId: string },
  ): Promise<void> {
    this.deps.interactionStore.register({
      interactionId: event.interactionId,
      chatId: ctx.chatId,
      workspaceId: ctx.workspaceId,
      kind: "plan",
      planData: {
        name: event.name,
        overview: event.overview,
        plan: event.plan,
        todos: event.todos,
      },
    });
    const title = event.name ?? "Untitled";
    await sendLongHtmlText(this.deps.messenger, ctx.chatId, event.plan, {
      header: `📋 Plan: ${title}`,
    });
    await this.deps.messenger.sendInteractiveMessage(ctx.chatId, {
      text: `<b>${escapeHtml(title)}</b> — approve and save to run later?`,
      parseMode: "HTML",
      buttons: [
        { id: `acp:${event.interactionId}:approve-save`, label: "Approve and save" },
        { id: `acp:${event.interactionId}:reject`, label: "Reject" },
      ],
    });
  }

  private async handleNotification(
    event: Extract<RuntimeStreamEvent, { type: "notification" }>,
    chatId: string,
  ): Promise<void> {
    const label =
      event.subtype === "todos"
        ? "📝 Tasks updated"
        : event.subtype === "task"
          ? "🤖 Subagent running"
          : "🔔 Notification";
    await this.deps.messenger.sendText(chatId, label);
  }

  async cancel(workspaceId: string): Promise<void> {
    const entry = this.pool.get(workspaceId);
    if (entry?.activeRun) {
      await entry.activeRun.cancel();
      if (entry.chatId) {
        this.deps.interactionStore.clearForChat(entry.chatId);
      }
    }
  }

  async resetWorkspace(workspaceId: string): Promise<void> {
    const entry = this.pool.get(workspaceId);
    if (entry) {
      if (entry.chatId) this.deps.interactionStore.clearForChat(entry.chatId);
      await entry.agent.dispose();
      this.pool.delete(workspaceId);
    }
    await this.deps.session.clear(workspaceId);
  }

  async dispose(): Promise<void> {
    for (const e of this.pool.values()) {
      try {
        await e.activeRun?.cancel();
      } catch {
        /* ignore */
      }
      try {
        await e.agent.dispose();
      } catch {
        /* ignore */
      }
    }
    this.pool.clear();
    this.deps.interactionStore.clearAll();
  }

  private async ensureAgent(
    workspaceId: string,
    cwd: string,
    userId: number,
  ): Promise<PoolEntry> {
    const cached = this.pool.get(workspaceId);
    if (cached) {
      if (cached.agent.alive !== false) return cached;
      logger.warn(
        { workspaceId, sessionId: cached.agent.sessionId },
        "ACP agent process died; recreating session",
      );
      this.pool.delete(workspaceId);
      try {
        await cached.agent.dispose();
      } catch {
        /* ignore */
      }
      await this.deps.session.clear(workspaceId);
    }

    if (this.deps.rateLimiter) {
      const r = this.deps.rateLimiter.check(userId, "sessionCreate");
      if (!r.allowed) {
        throw new RateLimitedError("sessionCreate", r.retryAfterMs);
      }
    }

    const sess = this.deps.session.get(workspaceId);
    let agent: RuntimeAgent;
    if (sess?.sessionId) {
      try {
        agent = await this.deps.runtime.resume(sess.sessionId, { cwd });
      } catch (e) {
        logger.warn(
          { err: (e as Error).message, sessionId: sess.sessionId, workspaceId },
          "ACP session/load failed; creating new session",
        );
        await this.deps.session.clear(workspaceId);
        agent = await this.deps.runtime.create({ cwd });
        await this.deps.session.set(workspaceId, {
          sessionId: agent.sessionId,
        });
      }
    } else {
      agent = await this.deps.runtime.create({ cwd });
      await this.deps.session.set(workspaceId, {
        sessionId: agent.sessionId,
      });
    }
    const entry: PoolEntry = { agent };
    this.pool.set(workspaceId, entry);
    return entry;
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return "menos de 1s";
  const seconds = Math.round(durationMs / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
