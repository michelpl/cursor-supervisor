import type { IMessenger, InteractiveMessage } from "../../src/core/messenger/IMessenger.js";
import type {
  IncomingTextMessage,
  IncomingImageMessage,
  IncomingImageGroup,
  IncomingCallbackQuery,
  MessageHandle,
  ImagePayload,
  FilePayload,
  SendOptions,
} from "../../src/core/messenger/types.js";

type Call =
  | { kind: "sendText"; chatId: string; text: string; opts?: SendOptions }
  | {
      kind: "editText";
      chatId: string;
      messageId: string;
      text: string;
      opts?: SendOptions;
    }
  | {
      kind: "sendInteractive";
      chatId: string;
      msg: InteractiveMessage;
    }
  | {
      kind: "sendImage";
      chatId: string;
      caption?: string;
      mimeType: string;
      size: number;
    }
  | {
      kind: "sendDocument";
      chatId: string;
      caption?: string;
      filename: string;
      size: number;
    }
  | { kind: "sendTyping"; chatId: string }
  | { kind: "answerCallbackQuery"; callbackQueryId: string; text?: string }
  | { kind: "clearInlineKeyboard"; chatId: string; messageId: string };

export class StubMessenger implements IMessenger {
  public calls: Call[] = [];
  public sentTexts: Array<{ chatId: string; text: string; opts?: SendOptions }> = [];
  public sentImages: Array<{ chatId: string; image: ImagePayload; caption?: string }> = [];
  public sentDocuments: Array<{ chatId: string; file: FilePayload; caption?: string }> = [];

  public sendImageImpl?: (
    chatId: string,
    image: ImagePayload,
    caption?: string,
  ) => Promise<void>;
  public sendDocumentImpl?: (
    chatId: string,
    file: FilePayload,
    caption?: string,
  ) => Promise<void>;

  public textListeners: Array<(m: IncomingTextMessage) => void> = [];
  public imageListeners: Array<(m: IncomingImageMessage) => void> = [];
  public imageGroupListeners: Array<(m: IncomingImageGroup) => void> = [];
  public callbackListeners: Array<(m: IncomingCallbackQuery) => void> = [];

  private idCounter = 0;
  private nextId(): string {
    return `m-${++this.idCounter}`;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

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

  emitText(m: IncomingTextMessage): void {
    for (const l of this.textListeners) l(m);
  }
  emitImage(m: IncomingImageMessage): void {
    for (const l of this.imageListeners) l(m);
  }
  emitImageGroup(m: IncomingImageGroup): void {
    for (const l of this.imageGroupListeners) l(m);
  }
  emitCallback(m: IncomingCallbackQuery): void {
    for (const l of this.callbackListeners) l(m);
  }

  async sendText(
    chatId: string,
    text: string,
    opts?: SendOptions,
  ): Promise<MessageHandle> {
    this.calls.push({ kind: "sendText", chatId, text, opts });
    this.sentTexts.push({ chatId, text, opts });
    return { messageId: this.nextId() };
  }

  async sendInteractiveMessage(
    chatId: string,
    msg: InteractiveMessage,
  ): Promise<MessageHandle> {
    this.calls.push({ kind: "sendInteractive", chatId, msg });
    return { messageId: this.nextId() };
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    this.calls.push({ kind: "answerCallbackQuery", callbackQueryId, text });
  }

  async clearInlineKeyboard(chatId: string, messageId: string): Promise<void> {
    this.calls.push({ kind: "clearInlineKeyboard", chatId, messageId });
  }

  async editText(
    chatId: string,
    messageId: string,
    text: string,
    opts?: SendOptions,
  ): Promise<void> {
    this.calls.push({ kind: "editText", chatId, messageId, text, opts });
  }

  async sendImage(
    chatId: string,
    image: ImagePayload,
    caption?: string,
  ): Promise<MessageHandle> {
    if (this.sendImageImpl) await this.sendImageImpl(chatId, image, caption);
    this.calls.push({
      kind: "sendImage",
      chatId,
      caption,
      mimeType: image.mimeType,
      size: image.data.length,
    });
    this.sentImages.push({ chatId, image, caption });
    return { messageId: this.nextId() };
  }

  async sendDocument(
    chatId: string,
    file: FilePayload,
    caption?: string,
  ): Promise<MessageHandle> {
    if (this.sendDocumentImpl) await this.sendDocumentImpl(chatId, file, caption);
    this.calls.push({
      kind: "sendDocument",
      chatId,
      caption,
      filename: file.filename,
      size: file.data.length,
    });
    this.sentDocuments.push({ chatId, file, caption });
    return { messageId: this.nextId() };
  }

  async sendTyping(chatId: string): Promise<void> {
    this.calls.push({ kind: "sendTyping", chatId });
  }
}
