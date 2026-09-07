import type { CommandContext } from "../dispatch.js";
import {
  addAndActivateWorkspace,
  applyWsUse,
  WorkspaceAddError,
} from "../../core/workspace/addWorkspace.js";
import { WorkspaceError } from "../../core/workspace/WorkspaceRegistry.js";
import { escapeHtml } from "../../util/html.js";

export { applyWsUse } from "../../core/workspace/addWorkspace.js";

/** Telegram callback_data max length. */
export const TELEGRAM_CALLBACK_DATA_MAX = 64;

const WS_USE_PREFIX = "ws:use:";

/** Static callback for "+ New workspace" help (no interactive wizard). */
export const WS_CREATE_CALLBACK_DATA = "ws:help:add";

export const WS_ADD_INSTRUCTIONS = [
  "<b>Add a workspace</b>",
  "",
  "Telegram:",
  "<code>/wsadd &lt;name&gt; &lt;abs-path&gt;</code>",
  "",
  "Or one-shot CLI (no multi-step approvals):",
  "<code>cursor-supervisor ws add &lt;name&gt; &lt;abs-path&gt;</code>",
  "",
  "Requirements:",
  "• <b>name</b> — short id (used in menus)",
  "• <b>abs-path</b> — absolute path to an existing directory",
  "• If <code>workspaces.allowedRoots</code> is set, the path must be under one of those roots",
  "",
  "Examples:",
  "<code>/wsadd myapp /home/you/projects/myapp</code>",
  "<code>cursor-supervisor ws add myapp C:\\Users\\you\\projects\\myapp</code>",
].join("\n");

export function wsUseCallbackData(name: string): string {
  return `${WS_USE_PREFIX}${name}`;
}

export function parseWsUseCallback(data: string): string | undefined {
  if (!data.startsWith(WS_USE_PREFIX)) return undefined;
  const name = data.slice(WS_USE_PREFIX.length);
  return name.length > 0 ? name : undefined;
}

export function isWsCreateHelpCallback(data: string): boolean {
  return data === WS_CREATE_CALLBACK_DATA;
}

export function isWsUseCallbackDataFits(name: string): boolean {
  return Buffer.byteLength(wsUseCallbackData(name), "utf8") <= TELEGRAM_CALLBACK_DATA_MAX;
}

export async function handleWs(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list": {
      const items = ctx.registry.list();
      const active = ctx.registry.getActive()?.name;
      const createBtn = {
        id: WS_CREATE_CALLBACK_DATA,
        label: "+ New workspace",
      };

      if (items.length === 0) {
        await ctx.messenger.sendInteractiveMessage(ctx.chatId, {
          text: "No workspaces registered.\nTap below for how to add one:",
          parseMode: "HTML",
          buttons: [createBtn],
        });
        return;
      }

      const longNames: string[] = [];
      const buttons: Array<{ id: string; label: string }> = [];
      for (const w of items) {
        if (!isWsUseCallbackDataFits(w.name)) {
          longNames.push(w.name);
          continue;
        }
        buttons.push({
          id: wsUseCallbackData(w.name),
          label: `${w.name === active ? "→ " : ""}${w.name}`,
        });
      }
      buttons.push(createBtn);

      const lines = items.map(
        (w) =>
          `${w.name === active ? "→ " : "  "}${escapeHtml(w.name)} — ${escapeHtml(w.path)}`,
      );
      if (longNames.length > 0) {
        lines.push(
          "",
          `Names too long for buttons (use <code>/ws use &lt;name&gt;</code>): ${longNames
            .map((n) => escapeHtml(n))
            .join(", ")}`,
        );
      }
      lines.push("", "Tap a workspace to switch, or create a new one:");

      await ctx.messenger.sendInteractiveMessage(ctx.chatId, {
        text: lines.join("\n"),
        parseMode: "HTML",
        buttons,
      });
      return;
    }
    case "use": {
      const name = args[1];
      if (!name) {
        await ctx.messenger.sendText(ctx.chatId, "Usage: /ws use <name>", {
          parseMode: "plain",
        });
        return;
      }
      try {
        const ws = await applyWsUse(
          ctx.registry,
          name,
          ctx.onWorkspaceActivated,
        );
        await ctx.messenger.sendText(
          ctx.chatId,
          `Active workspace: ${escapeHtml(ws.name)}\n${escapeHtml(ws.path)}`,
        );
      } catch (e) {
        if (e instanceof WorkspaceError) {
          await ctx.messenger.sendText(ctx.chatId, escapeHtml(e.message));
          return;
        }
        throw e;
      }
      return;
    }
    case "add": {
      const name = args[1];
      const path = args[2];
      try {
        const ws = await addAndActivateWorkspace({
          registry: ctx.registry,
          name: name ?? "",
          path: path ?? "",
          allowedRoots: ctx.workspaceAllowedRoots,
          onWorkspaceActivated: ctx.onWorkspaceActivated,
        });
        await ctx.messenger.sendText(
          ctx.chatId,
          `Workspace added and active: ${escapeHtml(ws.name)}\n${escapeHtml(ws.path)}`,
        );
      } catch (e) {
        if (e instanceof WorkspaceAddError) {
          if (e.code === "missing_args") {
            await ctx.messenger.sendText(
              ctx.chatId,
              "Usage: /wsadd <name> <abs-path>",
              { parseMode: "plain" },
            );
            return;
          }
          if (e.code === "outside_allowed_roots") {
            await ctx.messenger.sendText(
              ctx.chatId,
              "Path is outside the allowed directories (workspaces.allowedRoots).",
            );
            return;
          }
          await ctx.messenger.sendText(ctx.chatId, escapeHtml(e.message));
          return;
        }
        throw e;
      }
      return;
    }
    case "remove": {
      const name = args[1];
      if (!name) {
        await ctx.messenger.sendText(ctx.chatId, "Usage: /ws remove <name>", {
          parseMode: "plain",
        });
        return;
      }
      try {
        ctx.registry.remove(name);
        await ctx.registry.persist();
      } catch (e) {
        if (e instanceof WorkspaceError) {
          await ctx.messenger.sendText(ctx.chatId, escapeHtml(e.message));
          return;
        }
        throw e;
      }
      await ctx.messenger.sendText(ctx.chatId, `Workspace removed: ${escapeHtml(name)}`);
      return;
    }
    case "path": {
      const w = ctx.registry.getActive();
      await ctx.messenger.sendText(
        ctx.chatId,
        w ? escapeHtml(w.path) : "No active workspace.",
      );
      return;
    }
    default:
      await ctx.messenger.sendText(
        ctx.chatId,
        "Usage: /wslist | /wsadd | /ws use|remove|path",
      );
  }
}
