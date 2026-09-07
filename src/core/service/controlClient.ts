export interface ControlPromptRequest {
  text: string;
  force?: boolean;
  workspaceId?: string;
  origin?: "cli" | "ide";
}

export interface ControlPromptResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export async function postControlPrompt(
  port: number,
  token: string,
  body: ControlPromptRequest,
): Promise<ControlPromptResult> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/prompt`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

export interface ControlWorkspaceAddRequest {
  name: string;
  path: string;
}

export async function postControlWorkspaceAdd(
  port: number,
  token: string,
  body: ControlWorkspaceAddRequest,
): Promise<ControlPromptResult> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/workspaces`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}
