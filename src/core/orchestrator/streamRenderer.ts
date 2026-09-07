import type { IMessenger } from "../messenger/IMessenger.js";
import { markdownToHtml } from "../render/markdownToHtml.js";

export interface StreamRendererOptions {
  // text pushText text editMessageText text
  throttleMs: number;
  // text raw markdown text
  // HTML text 3000text
  maxLen: number;
}

/**
 * text assistant text + text
 * text maxLen text
 *
 * textM2 polishtext
 * - textBuffer text agent text markdowntextrawtext escape / text
 * - status / finalizeExtra text HTML text agenttext
 * - compose() text textBuffer text markdownToHtml(textBuffer)text
 *   text chunk text
 *
 * text
 * - editMessageText text Telegram text RPS text chunk text
 * - text rotate()textfinalize text text placeholder text text
 * - text timertext
 * - markdownToHtml text fallback text escapeHtmltext
 *   text streaming text
 */
export class StreamRenderer {
  private currentMsgId?: string;
  private status: string = "";
  // Compact timeline of what the Cursor agent is doing.  It is deliberately
  // kept in the streamed message (rather than sent as separate Telegram
  // messages) so a long task remains readable and does not flood the chat.
  private activity: string[] = [];
  private readonly startedAt = Date.now();
  // textraw markdowntext HTML
  private textBuffer: string = "";
  // finalize text HTML text "(text)" / text markdownToHtml
  private finalizeExtra: string = "";
  private flushTimer?: NodeJS.Timeout;
  private dirty = false;
  private finalized = false;

  constructor(
    private readonly messenger: IMessenger,
    private readonly chatId: string,
    private readonly opts: StreamRendererOptions,
  ) {}

  async start(initialPlaceholder: string, activityLine = "Cursor started"): Promise<void> {
    this.status = initialPlaceholder;
    this.recordActivity(activityLine);
    const handle = await this.messenger.sendText(this.chatId, this.compose());
    this.currentMsgId = handle.messageId;
  }

  setStatus(line: string): void {
    this.status = line;
    this.dirty = true;
    this.scheduleFlush();
  }

  /** Add a user-visible, timestamped Cursor activity entry. */
  recordActivity(line: string): void {
    const elapsedSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    const elapsed = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
    // Tool arguments can include arbitrary user text. Escape before this is
    // rendered with Telegram's HTML parse mode.
    this.activity.push(`${elapsed}  ${escapeHtmlFallback(line).slice(0, 120)}`);
    // Preserve the latest context while bounding the size of the Telegram
    // message and the amount of noise for tool-heavy tasks.
    if (this.activity.length > 6) this.activity.shift();
    this.dirty = true;
    this.scheduleFlush();
  }

  async pushText(chunk: string): Promise<void> {
    // textBuffer text chunk text text texthead text flush + rotatetextrest text
    // maxLen text raw textHTML text
    // Reserve room for the activity timeline and HTML expansion. The supplied
    // maxLen is intentionally below Telegram's 4096-character hard limit.
    const maxTextLen = Math.max(1, this.opts.maxLen - 600);
    if (this.textBuffer.length + chunk.length > maxTextLen) {
      const remaining = Math.max(0, maxTextLen - this.textBuffer.length);
      const head = chunk.slice(0, remaining);
      const rest = chunk.slice(remaining);
      this.textBuffer += head;
      this.dirty = true;
      await this.flushNow();
      await this.rotate();
      if (rest.length > 0) {
        await this.pushText(rest);
      }
      return;
    }
    this.textBuffer += chunk;
    this.dirty = true;
    this.scheduleFlush();
  }

  async finalize(extra?: string): Promise<void> {
    this.finalized = true;
    this.status = "";
    if (extra) this.finalizeExtra += extra;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    // finalize text messenger text
    // text dirty=falsetext cancel text pushTexttext flush text
    // text / text extra text
    this.dirty = true;
    await this.flushNow();
  }

  // text status / textBuffer / finalizeExtra text
  // texttextBuffer text markdownToHtmltextstatus / finalizeExtra text HTML text
  private compose(): string {
    const lines: string[] = [];
    if (this.status) {
      lines.push(`<b>Cursor</b> ${escapeHtmlFallback(this.status)}`, "");
    }
    if (this.activity.length > 0) {
      lines.push("<b>Activity</b>", this.activity.join("\n"), "");
    }
    if (this.textBuffer) {
      lines.push(this.renderTextBufferSafely());
    }
    if (this.finalizeExtra) {
      lines.push(this.finalizeExtra);
    }
    if (lines.length === 0) lines.push("…");
    return lines.join("\n");
  }

  // markdownToHtml text textBuffertext escapeHtml text
  private renderTextBufferSafely(): string {
    try {
      return markdownToHtml(this.textBuffer);
    } catch {
      return escapeHtmlFallback(this.textBuffer);
    }
  }

  // text dirty text throttle text
  private scheduleFlush(): void {
    if (this.finalized) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushNow();
    }, this.opts.throttleMs);
  }

  // text flushtext throttletext finalize text rotate text
  private async flushNow(): Promise<void> {
    if (!this.dirty || !this.currentMsgId) return;
    this.dirty = false;
    await this.messenger.editText(this.chatId, this.currentMsgId, this.compose());
  }

  // texttextBuffer / finalizeExtra text text text placeholder text messageId
  private async rotate(): Promise<void> {
    this.textBuffer = "";
    this.finalizeExtra = "";
    this.dirty = false;
    const handle = await this.messenger.sendText(this.chatId, "text continuing...");
    this.currentMsgId = handle.messageId;
    // text dirty text push text
    this.dirty = true;
  }
}

// markdownToHtml text escapetext
function escapeHtmlFallback(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
