// text Telegram text
const MAX_LEN = 60;

function trim(s: string): string {
  if (s.length <= MAX_LEN) return s;
  return s.slice(0, MAX_LEN) + "…";
}

function pickPath(a: Record<string, unknown> | undefined): string {
  // SDK text path text
  return (
    (a?.path as string | undefined) ??
    (a?.relative_path as string | undefined) ??
    ""
  );
}

/**
 * text SDK text args text
 *
 * SDK text"args / result schema text unknown text"text
 * text + as casttext
 */
export function summarizeTool(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : undefined) as
    | Record<string, unknown>
    | undefined;

  switch (name) {
    case "shell":
    case "execute":
      return `shell: ${trim((a?.command as string) ?? "")}`;
    case "read":
      return `read: ${pickPath(a)}`;
    case "write":
      return `write: ${pickPath(a)}`;
    case "edit":
      return `edit: ${pickPath(a)}`;
    case "grep":
      return `grep: ${trim((a?.pattern as string) ?? "")}`;
    case "glob":
      return `glob: ${trim((a?.pattern as string) ?? "")}`;
    case "ls":
      return `ls: ${(a?.path as string | undefined) ?? "."}`;
    case "task":
      return `subagent: ${trim((a?.description as string) ?? "")}`;
    default:
      return name;
  }
}

/** Extract a shell/execute command string from tool args / rawInput. */
export function extractCommand(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  if (typeof a.command === "string" && a.command.trim()) return a.command;
  return undefined;
}
