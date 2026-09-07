import type { CommandContext } from "../dispatch.js";

const HELP_TEXT = `<b>Cursor Supervisor</b> — Cursor via Telegram (ACP)

<code>/start</code> or <code>/help</code> — this help
<code>/wslist</code> — list workspaces
<code>/ws use &lt;name&gt;</code> — switch active workspace
<code>/wsadd &lt;name&gt; &lt;abs-path&gt;</code> — add a workspace
<code>/ws remove &lt;name&gt;</code> — remove a workspace
<code>/ws path</code> — path of the active workspace
<code>/reset</code> — restart the ACP session
<code>/cancel</code> — cancel the in-progress run
<code>/status</code> — workspace, session, mode, and pending plan
<code>/model &lt;id&gt;</code> — (no-op with ACP; model is set in the Cursor CLI)

<b>ACP modes</b>
<code>/plan &lt;task&gt;</code> — draft a plan (plan mode)
<code>/agent</code> — switch to agent mode
<code>/agent &lt;prompt&gt;</code> — run in agent mode
<code>/ask &lt;question&gt;</code> — ask mode (read-only)
Free text without a mode prefix: Cursor chooses the session mode.

<b>Plan → execute</b>
1. <code>/plan fix test X</code>
2. Approve and save the plan with the buttons
3. <code>/agent</code> then <code>/agent execute the plan</code>

<b>Reminders</b>
<code>/remind add text &lt;when&gt; &lt;text&gt;</code> — plain message
<code>/remind add prompt &lt;when&gt; &lt;prompt&gt;</code> — prompt the agent
<code>/remind list</code>
<code>/remind del &lt;id&gt;</code>
Formats: 10m, 1h30m | HH:MM | YYYY-MM-DDTHH:MM

<b>Attachments</b> — via the agent's shell tool:
<code>cursor-supervisor-attach-image /path/x.png [--caption "..."]</code>
<code>cursor-supervisor-attach-file  /path/x.pdf [--caption "..."]</code>
Delivered to Telegram after the run.

<b>Images</b> — send a photo or album; the agent analyzes it with the default prompt or your caption.

Prefix with <code>!</code> to force a new run (cancels the current one).`;

export async function handleHelp(ctx: CommandContext): Promise<void> {
  await ctx.messenger.sendText(ctx.chatId, HELP_TEXT, { parseMode: "HTML" });
}
