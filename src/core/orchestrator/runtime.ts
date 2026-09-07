// Runtime abstractions — ACP-backed agent execution for Cursor Supervisor.

export type AcpMode = "agent" | "plan" | "ask";

export interface RuntimeModeInfo {
  id: string;
  name: string;
  description?: string;
}

export interface IAgentRuntime {
  create(opts: CreateAgentOptions): Promise<RuntimeAgent>;
  resume(sessionId: string, opts: ResumeAgentOptions): Promise<RuntimeAgent>;
}

export interface CreateAgentOptions {
  cwd: string;
  mode?: AcpMode;
  mcpServers?: Record<string, unknown>;
}

export interface ResumeAgentOptions {
  cwd: string;
  mode?: AcpMode;
}

export interface RuntimeAgent {
  sessionId: string;
  /** False when the underlying ACP child process has exited or stdin closed. */
  alive?: boolean;
  send(
    text: string,
    opts?: {
      force?: boolean;
      images?: Array<{ data: string; mimeType: string }>;
    },
  ): Promise<RuntimeRun>;
  setMode(modeId: AcpMode): Promise<void>;
  getMode(): string | undefined;
  getAvailableModes(): RuntimeModeInfo[];
  dispose(): Promise<void>;
}

export type RuntimeInteractionResponse =
  | { kind: "permission"; optionId: string }
  | { kind: "question"; answers: Record<string, string[]> }
  | { kind: "plan"; accepted: boolean; save?: boolean };

export interface RuntimePermissionOption {
  optionId: string;
  name: string;
}

export interface RuntimeRun {
  status: "running" | "finished" | "error" | "cancelled";
  stream(): AsyncGenerator<RuntimeStreamEvent, void>;
  wait(): Promise<{
    status: "finished" | "error" | "cancelled";
    result?: string;
    durationMs?: number;
  }>;
  cancel(): Promise<void>;
  respond(interactionId: string, response: RuntimeInteractionResponse): Promise<void>;
}

export type RuntimeStreamEvent =
  | { type: "assistant"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call";
      status: "running" | "completed" | "error";
      name: string;
      args?: unknown;
    }
  | {
      type: "permission_request";
      interactionId: string;
      tool?: string;
      args?: unknown;
      summary?: string;
      /** Full command / primary detail for execute tools (shown in <pre>). */
      detail?: string;
      options?: RuntimePermissionOption[];
    }
  | {
      type: "question_request";
      interactionId: string;
      title?: string;
      questions: Array<{
        id: string;
        prompt: string;
        options: Array<{ id: string; label: string }>;
        allowMultiple?: boolean;
      }>;
    }
  | {
      type: "plan_request";
      interactionId: string;
      name?: string;
      overview?: string;
      plan: string;
      todos: Array<{ id: string; content: string; status: string }>;
    }
  | {
      type: "notification";
      subtype: "todos" | "task" | "generate_image";
      message?: string;
      params?: unknown;
    };
