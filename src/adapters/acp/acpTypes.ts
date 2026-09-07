/** Cursor ACP JSON-RPC message shapes (subset used by Cursor Supervisor). */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export interface SessionUpdateParams {
  update?: {
    sessionUpdate?: string;
    content?: { text?: string };
    modeId?: string;
    [key: string]: unknown;
  };
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface AcpPermissionToolCall {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown> | unknown;
  content?: unknown;
}

export interface PermissionRequestParams {
  sessionId?: string;
  toolCall?: AcpPermissionToolCall;
  options?: AcpPermissionOption[];
  /** Legacy / stub fields used in tests */
  tool?: string;
  args?: unknown;
  summary?: string;
  [key: string]: unknown;
}

export interface AskQuestionParams {
  toolCallId: string;
  title?: string;
  questions: Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple?: boolean;
  }>;
}

export interface CreatePlanParams {
  toolCallId: string;
  name?: string;
  overview?: string;
  plan: string;
  todos: Array<{
    id: string;
    content: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }>;
}

export type AcpMode = "agent" | "plan" | "ask";

export interface AcpModeInfo {
  id: string;
  name: string;
  description?: string;
}

export interface AcpSessionModes {
  currentModeId: string;
  availableModes: AcpModeInfo[];
}

export interface AcpSessionResult {
  sessionId: string;
  modes?: AcpSessionModes;
}

export interface AcpSessionConfig {
  agentCliPath: string;
  apiKey?: string;
  /** When omitted, Cursor CLI picks the default mode. */
  mode?: AcpMode;
  cwd: string;
}
