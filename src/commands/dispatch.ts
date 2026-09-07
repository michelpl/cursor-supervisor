import type { IMessenger } from "../core/messenger/IMessenger.js";
import type { WorkspaceRegistry } from "../core/workspace/WorkspaceRegistry.js";
import type { SessionStore } from "../core/session/SessionStore.js";
import type { AgentOrchestrator } from "../core/orchestrator/AgentOrchestrator.js";
import type { ReminderScheduler } from "../core/reminders/ReminderScheduler.js";
import type { ReminderQuota } from "../core/reminders/ReminderQuota.js";
import type { ParsedCommand } from "./parser.js";
import { handleHelp } from "./handlers/help.js";
import { handleWs } from "./handlers/ws.js";
import { handleReset } from "./handlers/reset.js";
import { handleCancel } from "./handlers/cancel.js";
import { handleStatus } from "./handlers/status.js";
import { handleModel } from "./handlers/model.js";
import { handleRemind } from "./handlers/remind.js";

// texthandlers text new text
export interface CommandContext {
  chatId: string;
  // M2text/remind text userIdtext reminder.createdBytextM1 text
  userId?: number;
  messenger: IMessenger;
  registry: WorkspaceRegistry;
  session: SessionStore;
  orchestrator: AgentOrchestrator;
  // M2textreminder text /remind text
  scheduler?: ReminderScheduler;
  reminderQuota?: ReminderQuota;
  reminderConfig?: { tz: string; maxAheadDays: number };
  // F-07text/ws add textundefined/[] text handler text
  workspaceAllowedRoots?: string[];
  /** Refresh claw marker / side effects when active workspace changes. */
  onWorkspaceActivated?: (wsPath: string) => Promise<void>;
}

export async function dispatchCommand(
  cmd: ParsedCommand,
  ctx: CommandContext,
): Promise<void> {
  switch (cmd.name) {
    case "start":
    case "help":
      return handleHelp(ctx);
    case "ws":
      return handleWs(cmd.args, ctx);
    case "wslist":
      return handleWs(["list", ...cmd.args], ctx);
    case "wsadd":
      return handleWs(["add", ...cmd.args], ctx);
    case "reset":
      return handleReset(ctx);
    case "cancel":
      return handleCancel(ctx);
    case "status":
      return handleStatus(ctx);
    case "model":
      return handleModel(cmd.args, ctx);
    case "remind":
      if (!ctx.scheduler || !ctx.reminderQuota || !ctx.reminderConfig) {
        await ctx.messenger.sendText(
          ctx.chatId,
          "/remind unavailable: scheduler is not configured.",
        );
        return;
      }
      return handleRemind(cmd.args, cmd.rest, {
        chatId: ctx.chatId,
        userId: ctx.userId ?? 0,
        messenger: ctx.messenger,
        scheduler: ctx.scheduler,
        reminderQuota: ctx.reminderQuota,
        registry: ctx.registry,
        now: () => Date.now(),
        tz: ctx.reminderConfig.tz,
        maxAheadDays: ctx.reminderConfig.maxAheadDays,
      });
    default:
      await ctx.messenger.sendText(
        ctx.chatId,
        `Unknown command: /${cmd.name}. Use /help.`,
      );
  }
}
