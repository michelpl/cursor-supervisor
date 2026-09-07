import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { logger } from "../../logger.js";
import type { AgentOrchestrator } from "../orchestrator/AgentOrchestrator.js";
import { parseForcePrefix } from "../orchestrator/busyPolicy.js";
import {
  addAndActivateWorkspace,
  WorkspaceAddError,
} from "../workspace/addWorkspace.js";
import type { WorkspaceRegistry } from "../workspace/WorkspaceRegistry.js";

const PromptBodySchema = z.object({
  text: z.string().min(1),
  force: z.boolean().optional(),
  workspaceId: z.string().min(1).optional(),
  origin: z.enum(["cli", "ide"]).optional(),
});

const WorkspaceAddBodySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

export type ControlPromptOrigin = "cli" | "ide";

export interface ControlServerDeps {
  orchestrator: AgentOrchestrator;
  /** Telegram chat id for mirroring (usually String(primaryUserId)). */
  chatId: string;
  userId: number;
  /** Called to check if a chat already has a running agent (busy). */
  isBusy: (chatId: string) => boolean;
  token: string;
  registry: WorkspaceRegistry;
  workspaceAllowedRoots: string[];
  onWorkspaceActivated?: (wsPath: string) => Promise<void>;
}

export interface ControlServerInfo {
  port: number;
  token: string;
}

/**
 * Loopback-only HTTP control plane so CLI/extension can start ACP runs
 * that mirror to Telegram, and register workspaces without a restart.
 */
export class ControlServer {
  private server?: Server;
  private port = 0;

  constructor(private readonly deps: ControlServerDeps) {}

  static generateToken(): string {
    return randomBytes(24).toString("base64url");
  }

  async start(): Promise<ControlServerInfo> {
    if (this.server) {
      return { port: this.port, token: this.deps.token };
    }

    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = this.server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("ControlServer failed to bind");
    }
    this.port = addr.port;
    logger.info({ port: this.port }, "ControlServer listening on 127.0.0.1");
    return { port: this.port, token: this.deps.token };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  getPort(): number {
    return this.port;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.authorize(req)) {
        this.json(res, 401, { error: "unauthorized" });
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/health") {
        this.json(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/prompt") {
        await this.handlePrompt(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/workspaces") {
        await this.handleWorkspaceAdd(req, res);
        return;
      }

      this.json(res, 404, { error: "not found" });
    } catch (e) {
      logger.error({ err: (e as Error).message }, "ControlServer request failed");
      this.json(res, 500, { error: "internal error" });
    }
  }

  private authorize(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return false;
    const token = header.slice("Bearer ".length).trim();
    return token.length > 0 && token === this.deps.token;
  }

  private async handlePrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let body: z.infer<typeof PromptBodySchema>;
    try {
      body = PromptBodySchema.parse(JSON.parse(raw || "{}"));
    } catch {
      this.json(res, 400, { error: "invalid body" });
      return;
    }

    const { text: stripped, force: forcePrefix } = parseForcePrefix(body.text);
    const force = body.force === true || forcePrefix;
    const origin = body.origin ?? "cli";

    if (this.deps.isBusy(this.deps.chatId) && !force) {
      this.json(res, 409, { error: "busy", message: "Agent is busy. Use force or prefix with !." });
      return;
    }

    // Fire-and-forget — HTTP returns before the ACP run finishes.
    void this.deps.orchestrator
      .runPrompt({
        chatId: this.deps.chatId,
        text: stripped,
        force,
        userId: this.deps.userId,
        origin,
        workspaceId: body.workspaceId,
      })
      .catch((e) => {
        logger.error(
          { err: (e as Error).message, origin },
          "ControlServer prompt run failed",
        );
      });

    this.json(res, 202, { accepted: true, origin });
  }

  private async handleWorkspaceAdd(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const raw = await readBody(req);
    let body: z.infer<typeof WorkspaceAddBodySchema>;
    try {
      body = WorkspaceAddBodySchema.parse(JSON.parse(raw || "{}"));
    } catch {
      this.json(res, 400, { error: "invalid body" });
      return;
    }

    try {
      const ws = await addAndActivateWorkspace({
        registry: this.deps.registry,
        name: body.name,
        path: body.path,
        allowedRoots: this.deps.workspaceAllowedRoots,
        onWorkspaceActivated: this.deps.onWorkspaceActivated,
      });
      this.json(res, 200, {
        name: ws.name,
        path: ws.path,
        active: true,
      });
    } catch (e) {
      if (e instanceof WorkspaceAddError) {
        const status = e.code === "already_exists" ? 409 : 400;
        this.json(res, status, { error: e.code, message: e.message });
        return;
      }
      throw e;
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const max = 256 * 1024;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
