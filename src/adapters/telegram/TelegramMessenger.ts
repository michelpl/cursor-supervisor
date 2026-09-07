import { InputFile, InlineKeyboard } from "grammy";
import { createBot, type GrammyBot } from "./grammyClient.js";
import { ImageGroupBuffer } from "./ImageGroupBuffer.js";
import { downloadTelegramFile } from "./downloadFile.js";
import type {
  IncomingTextMessage,
  IncomingImageMessage,
  IncomingImageGroup,
  IncomingCallbackQuery,
  MessageHandle,
  ImagePayload,
  FilePayload,
  SendOptions,
} from "../../core/messenger/types.js";
import type { IMessenger, InteractiveMessage } from "../../core/messenger/IMessenger.js";
import type { SpeechToText } from "../../core/stt/WhisperCppStt.js";
import { logger } from "../../logger.js";
import { sanitizeForOutput } from "../../util/sanitize.js";

export interface TelegramMessengerConfig {
  botToken: string;
  parseMode: "HTML" | "Markdown" | "plain";
  allowedUserIds?: number[];
  mediaGroupDebounceMs?: number;
  maxFileSizeBytes: number;
  /** When set, voice/audio messages are transcribed and emitted as text. */
  speechToText?: SpeechToText;
}

interface PendingPhoto {
  dataPromise: Promise<string>;
  mimeType: string;
  caption?: string;
  chatId: string;
  userId: number;
  username?: string;
}

/** Grammy-based IMessenger with inline keyboard support for ACP interactions. */
export class TelegramMessenger implements IMessenger {
  private bot?: GrammyBot;
  private textListeners: Array<(m: IncomingTextMessage) => void> = [];
  private imageListeners: Array<(m: IncomingImageMessage) => void> = [];
  private imageGroupListeners: Array<(m: IncomingImageGroup) => void> = [];
  private callbackListeners: Array<(m: IncomingCallbackQuery) => void> = [];
  private buffer?: ImageGroupBuffer<PendingPhoto>;

  constructor(private readonly cfg: TelegramMessengerConfig) {}

  async start(): Promise<void> {
    const bot = createBot(this.cfg.botToken);
    this.bot = bot;

    this.buffer = new ImageGroupBuffer<PendingPhoto>(
      this.cfg.mediaGroupDebounceMs ?? 200,
      (items) => {
        if (items.length === 0) return;
        void (async () => {
          try {
            const datas = await Promise.all(items.map((i) => i.dataPromise));
            const first = items[0]!;
            const caption = items.map((i) => i.caption).find((c) => !!c);
            const group: IncomingImageGroup = {
              chatId: first.chatId,
              userId: first.userId,
              username: first.username,
              images: items.map((i, idx) => ({
                data: datas[idx]!,
                mimeType: i.mimeType,
              })),
              caption,
            };
            for (const l of this.imageGroupListeners) l(group);
          } catch (e) {
            logger.error({ err: (e as Error).message }, "imageGroup flush failed");
          }
        })();
      },
    );

    bot.on("message:text", (ctx) => {
      const userId = ctx.from?.id;
      if (userId === undefined) return;
      if (this.cfg.allowedUserIds && !this.cfg.allowedUserIds.includes(userId)) {
        return;
      }
      const chatId = String(ctx.chat.id);
      const text = ctx.message.text;
      for (const l of this.textListeners) {
        l({ chatId, userId, username: ctx.from?.username, text });
      }
    });

    bot.on("callback_query:data", (ctx) => {
      const userId = ctx.from?.id;
      if (userId === undefined) return;
      // ACK immediately — Telegram expires callbacks in ~15s if unanswered.
      void ctx.answerCallbackQuery().catch((e) => {
        logger.warn(
          { err: (e as Error).message },
          "early answerCallbackQuery failed",
        );
      });
      if (this.cfg.allowedUserIds && !this.cfg.allowedUserIds.includes(userId)) {
        return;
      }
      const chatId = String(ctx.callbackQuery.message?.chat.id ?? ctx.chat?.id);
      if (!chatId) return;
      const messageId = ctx.callbackQuery.message?.message_id;
      const msg: IncomingCallbackQuery = {
        chatId,
        userId,
        callbackQueryId: ctx.callbackQuery.id,
        data: ctx.callbackQuery.data,
        messageId: messageId !== undefined ? String(messageId) : undefined,
      };
      for (const l of this.callbackListeners) l(msg);
    });

    bot.on("message:photo", (ctx) => {
      const userId = ctx.from?.id;
      if (userId === undefined) return;
      if (this.cfg.allowedUserIds && !this.cfg.allowedUserIds.includes(userId)) {
        return;
      }
      const chatId = String(ctx.chat.id);
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      if (!largest) return;
      const fileId = largest.file_id;
      const caption = ctx.message.caption ?? undefined;
      const groupId = ctx.message.media_group_id ?? undefined;
      const dataPromise = downloadTelegramFile({
        api: ctx.api,
        fileId,
        botToken: this.cfg.botToken,
        maxFileSizeBytes: this.cfg.maxFileSizeBytes,
      });
      dataPromise.catch(() => {});
      const item: PendingPhoto = {
        dataPromise,
        mimeType: "image/jpeg",
        caption,
        chatId,
        userId,
        username: ctx.from?.username,
      };
      this.buffer?.push(groupId, item);
    });

    const handleVoiceLike = (
      kind: "voice" | "audio",
      ctx: {
        from?: { id: number; username?: string };
        chat: { id: number };
        message: {
          voice?: { file_id: string };
          audio?: { file_id: string; title?: string };
          caption?: string;
        };
        api: Parameters<typeof downloadTelegramFile>[0]["api"];
      },
    ): void => {
      if (!this.cfg.speechToText) return;
      const userId = ctx.from?.id;
      if (userId === undefined) return;
      if (this.cfg.allowedUserIds && !this.cfg.allowedUserIds.includes(userId)) {
        return;
      }
      const fileId =
        kind === "voice" ? ctx.message.voice?.file_id : ctx.message.audio?.file_id;
      if (!fileId) return;
      const chatId = String(ctx.chat.id);
      const caption =
        ctx.message.caption ??
        (kind === "audio" ? ctx.message.audio?.title : undefined);
      void (async () => {
        try {
          const b64 = await downloadTelegramFile({
            api: ctx.api,
            fileId,
            botToken: this.cfg.botToken,
            maxFileSizeBytes: this.cfg.maxFileSizeBytes,
          });
          const bytes = Buffer.from(b64, "base64");
          const transcript = await this.cfg.speechToText!.transcribe(
            bytes,
            kind === "voice" ? "audio/ogg" : "audio/*",
          );
          if (!transcript.trim()) {
            await this.sendText(
              chatId,
              "Could not transcribe that audio (empty result).",
              { parseMode: "plain" },
            );
            return;
          }
          const text = caption?.trim()
            ? `[audio] ${caption.trim()}\n${transcript.trim()}`
            : transcript.trim();
          for (const l of this.textListeners) {
            l({
              chatId,
              userId,
              username: ctx.from?.username,
              text,
            });
          }
        } catch (e) {
          const msg = sanitizeForOutput((e as Error).message).slice(0, 400);
          logger.error({ err: msg, kind }, "voice/audio STT failed");
          try {
            await this.sendText(chatId, `Voice transcription failed: ${msg}`, {
              parseMode: "plain",
            });
          } catch {
            /* ignore */
          }
        }
      })();
    };

    bot.on("message:voice", (ctx) => {
      handleVoiceLike("voice", ctx as never);
    });
    bot.on("message:audio", (ctx) => {
      handleVoiceLike("audio", ctx as never);
    });

    bot.start({ drop_pending_updates: true }).catch((e) => {
      logger.error({ err: (e as Error).message }, "grammy start failed");
    });
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = undefined;
    }
    this.buffer?.dispose();
    this.buffer = undefined;
  }

  on(event: "text", h: (m: IncomingTextMessage) => void): void;
  on(event: "image", h: (m: IncomingImageMessage) => void): void;
  on(event: "imageGroup", h: (m: IncomingImageGroup) => void): void;
  on(event: "callback_query", h: (m: IncomingCallbackQuery) => void): void;
  on(
    event: "text" | "image" | "imageGroup" | "callback_query",
    h: (m: never) => void,
  ): void {
    if (event === "text") {
      this.textListeners.push(h as (m: IncomingTextMessage) => void);
    } else if (event === "image") {
      this.imageListeners.push(h as (m: IncomingImageMessage) => void);
    } else if (event === "imageGroup") {
      this.imageGroupListeners.push(h as (m: IncomingImageGroup) => void);
    } else {
      this.callbackListeners.push(h as (m: IncomingCallbackQuery) => void);
    }
  }

  async sendText(
    chatId: string,
    text: string,
    opts?: SendOptions,
  ): Promise<MessageHandle> {
    const safe = sanitizeForOutput(text);
    const r = await this.requireBot().api.sendMessage(Number(chatId), safe, {
      parse_mode: this.toParseMode(opts?.parseMode ?? this.cfg.parseMode),
      reply_parameters: opts?.replyToMessageId
        ? { message_id: Number(opts.replyToMessageId) }
        : undefined,
    });
    return { messageId: String(r.message_id) };
  }

  async sendInteractiveMessage(
    chatId: string,
    msg: InteractiveMessage,
  ): Promise<MessageHandle> {
    const keyboard = new InlineKeyboard();
    for (const btn of msg.buttons) {
      keyboard.text(sanitizeForOutput(btn.label), btn.id);
      keyboard.row();
    }
    const r = await this.requireBot().api.sendMessage(
      Number(chatId),
      sanitizeForOutput(msg.text),
      {
        parse_mode: this.toParseMode(msg.parseMode ?? this.cfg.parseMode),
        reply_markup: keyboard,
      },
    );
    return { messageId: String(r.message_id) };
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.requireBot().api.answerCallbackQuery(callbackQueryId, {
        text: text === undefined ? undefined : sanitizeForOutput(text),
      });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // Already answered by early ACK, or Telegram timeout — safe to ignore.
      if (
        msg.includes("query is too old") ||
        msg.includes("query ID is invalid") ||
        msg.includes("RESPONSE_TIMEOUT_EXPIRED")
      ) {
        return;
      }
      throw e;
    }
  }

  async clearInlineKeyboard(chatId: string, messageId: string): Promise<void> {
    try {
      await this.requireBot().api.editMessageReplyMarkup(
        Number(chatId),
        Number(messageId),
        { reply_markup: { inline_keyboard: [] } },
      );
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (
        msg.includes("message is not modified") ||
        msg.includes("message to edit not found") ||
        msg.includes("MESSAGE_ID_INVALID")
      ) {
        return;
      }
      logger.warn({ err: msg, chatId, messageId }, "clearInlineKeyboard failed");
    }
  }

  async editText(
    chatId: string,
    messageId: string,
    text: string,
    opts?: SendOptions,
  ): Promise<void> {
    try {
      await this.requireBot().api.editMessageText(
        Number(chatId),
        Number(messageId),
        sanitizeForOutput(text),
        {
          parse_mode: this.toParseMode(opts?.parseMode ?? this.cfg.parseMode),
        },
      );
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("message is not modified")) return;
      throw e;
    }
  }

  async sendImage(
    chatId: string,
    image: ImagePayload,
    caption?: string,
  ): Promise<MessageHandle> {
    const r = await this.requireBot().api.sendPhoto(
      Number(chatId),
      new InputFile(image.data, image.filename),
      {
        caption: caption === undefined ? undefined : sanitizeForOutput(caption),
        parse_mode: this.toParseMode(this.cfg.parseMode),
      },
    );
    return { messageId: String(r.message_id) };
  }

  async sendDocument(
    chatId: string,
    file: FilePayload,
    caption?: string,
  ): Promise<MessageHandle> {
    const r = await this.requireBot().api.sendDocument(
      Number(chatId),
      new InputFile(file.data, file.filename),
      {
        caption: caption === undefined ? undefined : sanitizeForOutput(caption),
        parse_mode: this.toParseMode(this.cfg.parseMode),
      },
    );
    return { messageId: String(r.message_id) };
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.requireBot().api.sendChatAction(Number(chatId), "typing");
  }

  private requireBot(): GrammyBot {
    if (!this.bot) throw new Error("TelegramMessenger not started");
    return this.bot;
  }

  private toParseMode(
    mode: "HTML" | "Markdown" | "plain",
  ): "HTML" | "MarkdownV2" | undefined {
    if (mode === "HTML") return "HTML";
    if (mode === "Markdown") return "MarkdownV2";
    return undefined;
  }
}
