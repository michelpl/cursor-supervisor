// text/text IMessenger text

export interface IncomingTextMessage {
  chatId: string;
  userId: number;
  username?: string;
  text: string;
}

export interface IncomingImageMessage {
  chatId: string;
  userId: number;
  username?: string;
  data: string;
  mimeType: string;
  caption?: string;
}

// M2text"text"text 1..N textcaption text
export interface IncomingImageGroup {
  chatId: string;
  userId: number;
  username?: string;
  images: Array<{ data: string; mimeType: string }>;
  caption?: string;
}

export interface SendOptions {
  // text parseMode text messenger text
  parseMode?: "HTML" | "Markdown" | "plain";
  replyToMessageId?: string;
}

export interface MessageHandle {
  messageId: string;
}

export interface ImagePayload {
  data: Buffer;
  mimeType: string;
  filename?: string;
}

export interface FilePayload {
  data: Buffer;
  mimeType?: string;
  filename: string;
}

export interface InteractiveButton {
  id: string;
  label: string;
}

export interface IncomingCallbackQuery {
  chatId: string;
  userId: number;
  callbackQueryId: string;
  data: string;
  /** Message that owns the inline keyboard, when present. */
  messageId?: string;
}
