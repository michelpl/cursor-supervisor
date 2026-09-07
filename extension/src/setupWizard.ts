import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as vscode from "vscode";
import { defaultDataDir } from "./paths";

export async function runSetupWizard(configPath: string): Promise<boolean> {
  const proceed = await vscode.window.showInformationMessage(
    "No Cursor Supervisor config found. Set up now? Tokens are stored in your user-global `~/.cursor-supervisor/config.json` (shared by the CLI and extension) and should not be committed.",
    { modal: true },
    "Set up",
  );
  if (proceed !== "Set up") return false;

  const botToken = await vscode.window.showInputBox({
    title: "Telegram bot token",
    prompt: "From @BotFather (TELEGRAM_BOT_TOKEN)",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Token is required"),
  });
  if (!botToken) return false;

  const apiKey = await vscode.window.showInputBox({
    title: "Cursor API key",
    prompt: "From Cursor Settings or `agent login` (CURSOR_API_KEY)",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "API key is required"),
  });
  if (!apiKey) return false;

  const idsRaw = await vscode.window.showInputBox({
    title: "Allowed Telegram user IDs",
    prompt: "Comma-separated numeric IDs (only these users can talk to the bot)",
    ignoreFocusOut: true,
    validateInput: (v) => {
      const parts = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length === 0) return "At least one user ID is required";
      if (parts.some((p) => !/^\d+$/.test(p))) return "IDs must be numbers";
      return undefined;
    },
  });
  if (!idsRaw) return false;

  const allowedUserIds = idsRaw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  const config = {
    telegram: {
      botToken: botToken.trim(),
      allowedUserIds,
      parseMode: "HTML",
    },
    cursor: {
      apiKey: apiKey.trim(),
      agentCliPath: "agent",
      acpMode: "agent",
      interactionTimeoutMs: 300000,
    },
    workspaces: { autoRegisterCwd: true, allowedRoots: [] as string[] },
    paths: { dataDir: defaultDataDir() },
    logging: { level: "info" },
    reminders: { timezone: "UTC", maxAheadDays: 30 },
    attachments: {
      maxFileSizeBytes: 20971520,
      maxAttachmentsPerFlush: 10,
      maxRetries: 3,
    },
    images: {
      maxImagesPerPrompt: 8,
      defaultPromptSingle: "Analyze this image and describe what you see.",
      defaultPromptMulti: "Analyze these images and describe what you see.",
      mediaGroupDebounceMs: 800,
    },
    rateLimit: {
      message: { capacity: 4, refillPerSec: 2 },
      sessionCreate: { capacity: 10, refillPerSec: 0.1667 },
      reminders: { maxPerUser: 100 },
    },
  };

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  void vscode.window.showInformationMessage(
    `Wrote ${configPath}. Config and data are user-global under ~/.cursor-supervisor/.`,
  );
  return true;
}
