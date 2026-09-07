import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "../config/loadConfig.js";
import { resolveConfigFilePath } from "../config/paths.js";
import { logger } from "../logger.js";
import { TelegramMessenger } from "../adapters/telegram/TelegramMessenger.js";
import {
  WorkspaceRegistry,
  WorkspaceError,
} from "../core/workspace/WorkspaceRegistry.js";
import { writeClawMarker } from "../core/workspace/clawMarker.js";
import { resolveWorkspaceAllowedRoots } from "../core/workspace/resolveAllowedRoots.js";
import { applyWsUse } from "../core/workspace/addWorkspace.js";
import { SessionStore } from "../core/session/SessionStore.js";
import { AccessControl } from "../core/access/AccessControl.js";
import { AgentOrchestrator } from "../core/orchestrator/AgentOrchestrator.js";
import { AcpRuntime } from "../core/orchestrator/acpRuntime.js";
import { AttachmentQueue } from "../core/attachments/AttachmentQueue.js";
import { AttachmentDispatcher } from "../core/attachments/AttachmentDispatcher.js";
import { ReminderStore } from "../core/reminders/ReminderStore.js";
import { ReminderQuota } from "../core/reminders/ReminderQuota.js";
import { ReminderScheduler } from "../core/reminders/ReminderScheduler.js";
import { PendingInteractionStore } from "../core/interactions/PendingInteractionStore.js";
import { InteractionRouter } from "../core/interactions/InteractionRouter.js";
import { parseCommand } from "../commands/parser.js";
import { parseModeCommand, modeCommandHelp } from "../commands/modeCommands.js";
import {
  parseWsUseCallback,
  isWsCreateHelpCallback,
  WS_ADD_INSTRUCTIONS,
} from "../commands/handlers/ws.js";
import {
  buildExecutionPrompt,
  shouldInjectApprovedPlan,
} from "../core/orchestrator/planPrompt.js";
import {
  ApprovedPlanStore,
  approvedPlanStorePath,
} from "../core/plans/ApprovedPlanStore.js";
import { dispatchCommand } from "../commands/dispatch.js";
import { parseForcePrefix } from "../core/orchestrator/busyPolicy.js";
import { sanitizeForOutput } from "../util/sanitize.js";
import { escapeHtml } from "../util/html.js";
import { RateLimiter } from "../core/rateLimit/RateLimiter.js";
import { rateLimitGuard } from "./wiring/rateLimitGuard.js";
import { ServiceLock, ServiceAlreadyRunningError } from "../core/service/ServiceLock.js";
import { SleepBlocker } from "../core/service/SleepBlocker.js";
import { ControlServer } from "../core/service/ControlServer.js";
import {
  WhisperCppStt,
  assertVoiceSttReady,
} from "../core/stt/WhisperCppStt.js";

export interface RunBotOptions {
  configPath?: string;
  startedBy?: "cli" | "extension";
}

export async function runBot(opts: RunBotOptions = {}): Promise<void> {
  const configPath = await resolveConfigFilePath(opts.configPath);
  const cfg = await loadConfig({ configPath });
  if (
    cfg.cursor.apiKey.startsWith("REPLACE_") ||
    cfg.cursor.apiKey === "key_..."
  ) {
    throw new Error(
      "cursor.apiKey is not configured. Set CURSOR_API_KEY in the environment or edit config.json.",
    );
  }
  if (/^\d+:[A-Za-z0-9_-]+$/.test(cfg.cursor.apiKey)) {
    logger.warn(
      "cursor.apiKey looks like a Telegram bot token, not a Cursor key (key_…). " +
        "Get it from Cursor Settings or run `agent login`.",
    );
  }
  const dataDir = cfg.paths.dataDir;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const serviceLock = new ServiceLock(dataDir);
  try {
    await serviceLock.acquire({
      configPath: resolve(configPath),
      cwd: process.cwd(),
      startedBy: opts.startedBy ?? "cli",
    });
  } catch (e) {
    if (e instanceof ServiceAlreadyRunningError) {
      throw new Error(
        `${e.message}. Use \`cursor-supervisor status\` or \`cursor-supervisor stop\`.`,
        { cause: e },
      );
    }
    throw e;
  }

  const registry = new WorkspaceRegistry(join(dataDir, "workspaces.json"));
  await registry.init({
    autoRegisterCwd: cfg.workspaces.autoRegisterCwd,
    cwd: process.cwd(),
  });

  const session = new SessionStore(join(dataDir, "sessions.json"));
  await session.init();

  const approvedPlanStore = new ApprovedPlanStore(approvedPlanStorePath(dataDir));
  await approvedPlanStore.init();

  const onWorkspaceActivated = async (wsPath: string): Promise<void> => {
    await writeClawMarker(wsPath, dataDir);
  };

  const access = new AccessControl(cfg.telegram.allowedUserIds);

  let speechToText: WhisperCppStt | undefined;
  if (cfg.voice.enabled) {
    if (!cfg.voice.modelPath.trim()) {
      throw new Error(
        "voice.enabled is true but voice.modelPath is empty. Set the path to a whisper.cpp ggml model.",
      );
    }
    await assertVoiceSttReady({ modelPath: cfg.voice.modelPath });
    speechToText = new WhisperCppStt({
      whisperCliPath: cfg.voice.whisperCliPath,
      modelPath: cfg.voice.modelPath,
      ffmpegPath: cfg.voice.ffmpegPath,
      language: cfg.voice.language,
      timeoutMs: cfg.voice.timeoutMs,
      tempRoot: join(dataDir, "stt-tmp"),
    });
    logger.info(
      { language: cfg.voice.language, modelPath: cfg.voice.modelPath },
      "voice STT enabled (whisper.cpp)",
    );
  }

  const messenger = new TelegramMessenger({
    botToken: cfg.telegram.botToken,
    parseMode: cfg.telegram.parseMode,
    allowedUserIds: cfg.telegram.allowedUserIds,
    mediaGroupDebounceMs: cfg.images.mediaGroupDebounceMs,
    maxFileSizeBytes: cfg.attachments.maxFileSizeBytes,
    speechToText,
  });

  const runtime = new AcpRuntime({
    agentCliPath: cfg.cursor.agentCliPath,
    apiKey: cfg.cursor.apiKey,
    mode: cfg.cursor.acpMode,
  });

  const queue = new AttachmentQueue(join(dataDir, "attachments", "queue.jsonl"));
  const pendingRoot = join(dataDir, "attachments", "pending");
  const dispatcher = new AttachmentDispatcher({
    queue,
    messenger,
    maxRetries: cfg.attachments.maxRetries,
    maxPerFlush: cfg.attachments.maxAttachmentsPerFlush,
    pendingRoot,
  });

  const reminderStore = new ReminderStore(join(dataDir, "reminders.json"));
  await reminderStore.init();

  const limiter = new RateLimiter({
    buckets: {
      msg: cfg.rateLimit.message,
      sessionCreate: cfg.rateLimit.sessionCreate,
    },
  });

  const interactionStore = new PendingInteractionStore({
    dataDir,
    timeoutMs: cfg.cursor.interactionTimeoutMs,
  });
  await interactionStore.init();

  const orchestrator = new AgentOrchestrator({
    messenger,
    runtime,
    registry,
    session,
    streamOptions: { throttleMs: 800, maxLen: 3000 },
    acpMode: cfg.cursor.acpMode,
    attachmentDispatcher: dispatcher,
    rateLimiter: limiter,
    interactionStore,
    approvedPlanStore,
  });

  interactionStore.setOnTimeout(async (item) => {
    logger.warn({ interactionId: item.interactionId }, "interaction timed out");
    try {
      await orchestrator.respondToInteraction(
        item.chatId,
        item.interactionId,
        interactionStore.defaultTimeoutResponse(item.kind),
      );
      await messenger.sendText(
        item.chatId,
        "⏱ Interaction expired — a default response was applied.",
      );
    } catch (e) {
      logger.error({ err: (e as Error).message }, "interaction timeout handler failed");
    }
  });

  const interactionRouter = new InteractionRouter(interactionStore);

  const primaryUserId = access.primaryUserId();
  if (primaryUserId === undefined) {
    throw new Error("telegram.allowedUserIds must contain at least one user id");
  }
  const notifyChatId = String(primaryUserId);

  const workspaceAllowedRoots = resolveWorkspaceAllowedRoots(
    cfg.workspaces.allowedRoots,
    registry,
  );

  const controlToken = ControlServer.generateToken();
  const controlServer = new ControlServer({
    orchestrator,
    chatId: notifyChatId,
    userId: primaryUserId,
    token: controlToken,
    isBusy: (chatId) =>
      orchestrator.isRunning(chatId) || orchestrator.hasPendingInteraction(chatId),
    registry,
    workspaceAllowedRoots,
    onWorkspaceActivated,
  });
  const controlInfo = await controlServer.start();
  await serviceLock.updateControl({
    controlPort: controlInfo.port,
    controlToken: controlInfo.token,
  });

  const sleepBlocker = new SleepBlocker();
  if (cfg.power.preventSleep) {
    await sleepBlocker.acquire();
  }

  const scheduler = new ReminderScheduler({
    store: reminderStore,
    runReminder: (input) => orchestrator.runReminder(input),
    sendText: async (chatId, text) => {
      await messenger.sendText(chatId, text);
    },
  });
  const reminderQuota = new ReminderQuota(scheduler, {
    maxPerUser: cfg.rateLimit.reminders.maxPerUser,
  });
  await scheduler.start();

  const activeWs = registry.getActive();
  if (activeWs) await onWorkspaceActivated(activeWs.path);

  messenger.on("text", (msg) => {
    logger.info(
      { userId: msg.userId, username: msg.username, len: msg.text.length },
      "incoming text",
    );
    if (!access.isAllowed(msg.userId)) {
      logger.warn({ userId: msg.userId }, "user not in allowedUserIds");
      return;
    }
    void (async () => {
      const ok = await rateLimitGuard({
        limiter,
        messenger,
        chatId: msg.chatId,
        userId: msg.userId,
        key: "msg",
      });
      if (!ok) return;
      await handleText(msg.chatId, msg.text, msg.userId);
    })();
  });

  messenger.on("image", () => {});

  messenger.on("imageGroup", (msg) => {
    if (!access.isAllowed(msg.userId)) {
      logger.warn({ userId: msg.userId }, "user not in allowedUserIds");
      return;
    }
    logger.info(
      { userId: msg.userId, n: msg.images.length, hasCaption: !!msg.caption },
      "incoming imageGroup",
    );
    void (async () => {
      const ok = await rateLimitGuard({
        limiter,
        messenger,
        chatId: msg.chatId,
        userId: msg.userId,
        key: "msg",
      });
      if (!ok) return;
      await handleImageGroup(msg.chatId, msg.images, msg.caption, msg.userId);
    })();
  });

  messenger.on("callback_query", (msg) => {
    if (!access.isAllowed(msg.userId)) return;
    void (async () => {
      try {
        const wsName = parseWsUseCallback(msg.data);
        if (wsName !== undefined) {
          try {
            const ws = await applyWsUse(registry, wsName, onWorkspaceActivated);
            await messenger.answerCallbackQuery(
              msg.callbackQueryId,
              `Active: ${ws.name}`,
            );
            if (msg.messageId) {
              await messenger.clearInlineKeyboard(msg.chatId, msg.messageId);
            }
            await messenger.sendText(
              msg.chatId,
              `Active workspace: ${escapeHtml(ws.name)}\n${escapeHtml(ws.path)}`,
            );
          } catch (e) {
            const errMsg =
              e instanceof WorkspaceError
                ? e.message
                : (e as Error).message;
            await messenger.answerCallbackQuery(msg.callbackQueryId, errMsg);
            await messenger.sendText(msg.chatId, escapeHtml(errMsg));
          }
          return;
        }

        if (isWsCreateHelpCallback(msg.data)) {
          await messenger.answerCallbackQuery(msg.callbackQueryId);
          await messenger.sendText(msg.chatId, WS_ADD_INSTRUCTIONS, {
            parseMode: "HTML",
          });
          return;
        }

        const routed = interactionRouter.routeCallback(msg.chatId, msg.data);
        if (!routed) {
          logger.warn(
            { chatId: msg.chatId, data: msg.data },
            "callback did not match a pending interaction",
          );
          return;
        }
        if (routed.action === "ack") {
          // Multi-select: option recorded; wait for Confirm.
          return;
        }
        if (routed.action !== "respond") return;

        const ok = await orchestrator.respondToInteraction(
          msg.chatId,
          routed.interactionId,
          routed.response,
        );
        if (!ok) {
          logger.warn(
            { chatId: msg.chatId, interactionId: routed.interactionId },
            "respondToInteraction returned false",
          );
          if (msg.messageId) {
            await messenger.clearInlineKeyboard(msg.chatId, msg.messageId);
          }
          await messenger.sendText(
            msg.chatId,
            "Could not apply that choice — the agent may no longer be waiting. Try again or /cancel.",
          );
          return;
        }
        if (msg.messageId) {
          await messenger.clearInlineKeyboard(msg.chatId, msg.messageId);
        }
      } catch (e) {
        logger.error(
          { err: (e as Error).message, data: msg.data },
          "callback_query handler failed",
        );
        try {
          await messenger.sendText(
            msg.chatId,
            "Failed to apply your choice. Please try again or /cancel.",
          );
        } catch {
          /* ignore */
        }
      }
    })();
  });

  await messenger.start();
  logger.info("Cursor Supervisor started (ACP mode)");

  const shutdown = async (): Promise<void> => {
    logger.info("shutting down...");
    try {
      await controlServer.stop();
    } catch (e) {
      logger.error({ err: (e as Error).message }, "control server stop");
    }
    try {
      await sleepBlocker.release();
    } catch (e) {
      logger.error({ err: (e as Error).message }, "sleep blocker release");
    }
    try {
      await messenger.stop();
    } catch (e) {
      logger.error({ err: (e as Error).message }, "messenger stop");
    }
    try {
      scheduler.dispose();
    } catch (e) {
      logger.error({ err: (e as Error).message }, "scheduler dispose");
    }
    try {
      interactionStore.dispose();
    } catch (e) {
      logger.error({ err: (e as Error).message }, "interaction store dispose");
    }
    try {
      await orchestrator.dispose();
    } catch (e) {
      logger.error({ err: (e as Error).message }, "orch dispose");
    }
    try {
      await serviceLock.release();
    } catch (e) {
      logger.error({ err: (e as Error).message }, "service lock release");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  async function handleImageGroup(
    chatId: string,
    images: Array<{ data: string; mimeType: string }>,
    caption: string | undefined,
    userId: number,
  ): Promise<void> {
    try {
      const cap = cfg.images.maxImagesPerPrompt;
      let used = images;
      if (images.length > cap) {
        used = images.slice(0, cap);
        await messenger.sendText(
          chatId,
          `Image limit is ${cap} per prompt — using the first ${cap}.`,
        );
      }
      const text =
        caption ??
        (used.length > 1
          ? cfg.images.defaultPromptMulti
          : cfg.images.defaultPromptSingle);
      const { force, text: clean } = parseForcePrefix(text);
      await orchestrator.runPromptWithImages({
        chatId,
        text: clean,
        images: used,
        force,
        userId,
      });
    } catch (e) {
      logger.error({ err: (e as Error).message }, "handleImageGroup failed");
      try {
        const safeMsg = sanitizeForOutput((e as Error).message);
        await messenger.sendText(chatId, `Error: ${safeMsg}`.slice(0, 800), {
          parseMode: "plain",
        });
      } catch {
        /* ignore */
      }
    }
  }

  async function handleText(
    chatId: string,
    text: string,
    userId: number,
  ): Promise<void> {
    try {
      const routed = interactionRouter.routeText(chatId, text);
      if (routed.action === "respond") {
        const ok = await orchestrator.respondToInteraction(
          chatId,
          routed.interactionId,
          routed.response,
        );
        if (ok) return;
      }

      const parsed = parseCommand(text);
      if (parsed.type === "command") {
        const modeCmd = parseModeCommand(parsed);
        if (modeCmd) {
          if (modeCmd.kind === "help") {
            await messenger.sendText(chatId, modeCommandHelp(modeCmd.mode), {
              parseMode: "plain",
            });
            return;
          }
          if (modeCmd.kind === "set-only") {
            await orchestrator.setSessionMode({
              chatId,
              mode: modeCmd.mode,
              userId,
            });
            await messenger.sendText(chatId, `Mode ${modeCmd.mode} is active.`, {
              parseMode: "plain",
            });
            return;
          }
          let promptText = modeCmd.text;
          const ws = registry.getActive();
          if (ws && modeCmd.mode === "agent") {
            const approved = approvedPlanStore.get(ws.name);
            if (approved && shouldInjectApprovedPlan(promptText)) {
              promptText = buildExecutionPrompt(promptText, approved.plan);
            }
          }
          const { force, text: clean } = parseForcePrefix(promptText);
          await orchestrator.runPrompt({
            chatId,
            text: clean,
            force,
            userId,
            mode: modeCmd.mode,
          });
          return;
        }

        await dispatchCommand(parsed, {
          chatId,
          userId,
          messenger,
          registry,
          session,
          orchestrator,
          scheduler,
          reminderQuota,
          workspaceAllowedRoots,
          onWorkspaceActivated,
          reminderConfig: {
            tz: cfg.reminders.timezone,
            maxAheadDays: cfg.reminders.maxAheadDays,
          },
        });
        return;
      }
      const { force, text: clean } = parseForcePrefix(parsed.text);
      await orchestrator.runPrompt({ chatId, text: clean, force, userId });
    } catch (e) {
      logger.error({ err: (e as Error).message }, "handleText failed");
      try {
        const safeMsg = sanitizeForOutput((e as Error).message);
        await messenger.sendText(chatId, `Error: ${safeMsg}`.slice(0, 800), {
          parseMode: "plain",
        });
      } catch {
        /* ignore */
      }
    }
  }
}
