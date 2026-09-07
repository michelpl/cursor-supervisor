import type {
  IncomingTextMessage,
  IncomingImageMessage,
  IncomingImageGroup,
  IncomingCallbackQuery,
  MessageHandle,
  SendOptions,
  ImagePayload,
  FilePayload,
  InteractiveButton,
} from "./types.js";

export interface InteractiveMessage {
  text: string;
  buttons: InteractiveButton[];
  parseMode?: "HTML" | "Markdown" | "plain";
}

export interface IMessenger {
  start(): Promise<void>;
  stop(): Promise<void>;

  on(event: "text", h: (msg: IncomingTextMessage) => void): void;
  on(event: "image", h: (msg: IncomingImageMessage) => void): void;
  on(event: "imageGroup", h: (msg: IncomingImageGroup) => void): void;
  on(event: "callback_query", h: (msg: IncomingCallbackQuery) => void): void;

  sendText(chatId: string, text: string, opts?: SendOptions): Promise<MessageHandle>;
  editText(chatId: string, messageId: string, text: string, opts?: SendOptions): Promise<void>;
  sendInteractiveMessage(chatId: string, msg: InteractiveMessage): Promise<MessageHandle>;
  /** Remove inline keyboard from a message (no-op if already cleared). */
  clearInlineKeyboard(chatId: string, messageId: string): Promise<void>;
  sendImage(chatId: string, image: ImagePayload, caption?: string): Promise<MessageHandle>;
  sendDocument(chatId: string, file: FilePayload, caption?: string): Promise<MessageHandle>;

  sendTyping(chatId: string): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}
