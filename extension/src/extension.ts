import * as vscode from "vscode";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ServiceClient,
  resolveConfigPath,
  workspaceHasConfig,
  type ServiceStatus,
} from "./serviceClient";
import { runSetupWizard } from "./setupWizard";
import {
  getSecretFlags,
  promptAndSaveSecret,
  writeSecretField,
} from "./configSecrets";
import {
  CONFIG_VIEW_ID,
  ConfigViewProvider,
} from "./configView";
import {
  DEFAULT_CONFIG_PATH_SETTING,
  defaultConfigPath,
} from "./paths";

type BarState = "stopped" | "starting" | "running" | "error";

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBar.command = "cursorSupervisor.showStatus";
  context.subscriptions.push(statusBar);

  let barState: BarState = "stopped";
  let lastError = "";
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let ignoreEnabledChange = false;
  let configView: ConfigViewProvider | undefined;

  function getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    // Extension Development Host may open before a folder is selected
    const ext = context.extensionPath.replace(/\\/g, "/");
    if (ext.endsWith("/extension")) {
      return ext.slice(0, -"/extension".length).replace(/\//g, "\\");
    }
    return undefined;
  }

  function resolveConfig(root: string, setting: string): string {
    const fromSetting = resolveConfigPath(root, setting);
    if (existsSync(fromSetting)) return fromSetting;
    const globalPath = defaultConfigPath();
    if (existsSync(globalPath)) return globalPath;
    const inSupervisorDir = join(root, ".cursor-supervisor", "config.json");
    if (existsSync(inSupervisorDir)) return inSupervisorDir;
    const atRoot = join(root, "config.json");
    if (existsSync(atRoot)) return atRoot;
    const parent = join(dirname(root), "config.json");
    if (existsSync(parent)) return parent;
    return fromSetting;
  }

  function getSettings() {
    const cfg = vscode.workspace.getConfiguration("cursorSupervisor");
    const root = getWorkspaceRoot();
    if (!root) {
      return null;
    }
    return {
      enabled: cfg.get<boolean>("enabled", true),
      autoStart: cfg.get<boolean>("autoStart", false),
      configPath: resolveConfig(
        root,
        cfg.get<string>("configPath", DEFAULT_CONFIG_PATH_SETTING),
      ),
      nodePath: cfg.get<string>("nodePath", "node"),
      executablePath: cfg.get<string>("executablePath", ""),
      detach: cfg.get<boolean>("detach", true),
      pollMs: cfg.get<number>("statusPollIntervalMs", 5000),
      workspaceRoot: root,
    };
  }

  function makeClient(): ServiceClient | undefined {
    const s = getSettings();
    if (!s) return undefined;
    return new ServiceClient({
      workspaceRoot: s.workspaceRoot,
      configPath: s.configPath,
      nodePath: s.nodePath,
      executablePath: s.executablePath,
      detach: s.detach,
      extensionPath: context.extensionPath,
    });
  }

  function renderBar(status?: ServiceStatus): void {
    switch (barState) {
      case "starting":
        statusBar.text = "$(sync~spin) Cursor Supervisor: starting…";
        statusBar.tooltip = "Starting Cursor Supervisor…";
        statusBar.backgroundColor = undefined;
        break;
      case "running":
        statusBar.text = status?.pid
          ? `$(pass-filled) Cursor Supervisor: running (pid ${status.pid})`
          : "$(pass-filled) Cursor Supervisor: running";
        statusBar.tooltip = formatStatusTooltip(status);
        statusBar.backgroundColor = undefined;
        break;
      case "error":
        statusBar.text = "$(error) Cursor Supervisor: error";
        statusBar.tooltip = lastError || "An error occurred";
        statusBar.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        break;
      default:
        statusBar.text = "$(circle-slash) Cursor Supervisor: stopped";
        statusBar.tooltip = "Click for status — use Cursor Supervisor: Start to run";
        statusBar.backgroundColor = undefined;
    }
    statusBar.show();
  }

  function formatStatusTooltip(status?: ServiceStatus): string {
    if (!status?.running) return "Cursor Supervisor is not running";
    const lines = [
      `PID: ${status.pid}`,
      `Since: ${status.startedAt}`,
      `Config: ${status.configPath}`,
      `CWD: ${status.cwd}`,
      `Started by: ${status.startedBy}`,
    ];
    return lines.join("\n");
  }

  function formatSince(iso?: string): string {
    if (!iso) return "unknown";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  async function refreshStatus(): Promise<ServiceStatus | undefined> {
    const client = makeClient();
    if (!client) {
      barState = "stopped";
      renderBar();
      return undefined;
    }
    try {
      const status = await client.getStatus();
      if (barState !== "starting") {
        barState = status.running ? "running" : "stopped";
      }
      if (status.running) barState = "running";
      lastError = "";
      renderBar(status);
      return status;
    } catch (e) {
      if (barState !== "starting") {
        barState = "error";
        lastError = (e as Error).message;
        renderBar();
      }
      return undefined;
    }
  }

  function startPolling(): void {
    const s = getSettings();
    if (!s) return;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => void refreshStatus(), s.pollMs);
    context.subscriptions.push({ dispose: () => clearInterval(pollTimer!) });
  }

  async function handleRunningConflict(
    status: ServiceStatus,
    source: "start" | "autostart",
  ): Promise<"use" | "restart" | "cancel"> {
    const choice = await vscode.window.showWarningMessage(
      `Cursor Supervisor is already running (PID ${status.pid}, since ${formatSince(status.startedAt)}).`,
      { modal: true },
      "Use existing instance",
      "Stop and restart",
      "Cancel",
    );
    if (choice === "Use existing instance") return "use";
    if (choice === "Stop and restart") return "restart";
    if (source === "autostart") return "cancel";
    return "cancel";
  }

  function enabledUpdateTarget(): vscode.ConfigurationTarget {
    const inspect = vscode.workspace
      .getConfiguration("cursorSupervisor")
      .inspect<boolean>("enabled");
    if (inspect?.workspaceFolderValue !== undefined) {
      return vscode.ConfigurationTarget.WorkspaceFolder;
    }
    if (inspect?.workspaceValue !== undefined) {
      return vscode.ConfigurationTarget.Workspace;
    }
    if (inspect?.globalValue !== undefined) {
      return vscode.ConfigurationTarget.Global;
    }
    return vscode.ConfigurationTarget.Workspace;
  }

  async function handleEnabledChanged(): Promise<void> {
    if (ignoreEnabledChange) return;
    const s = getSettings();
    if (!s) return;
    if (s.enabled) {
      void vscode.window.showInformationMessage(
        "Cursor Supervisor is enabled. Use Start to run the service.",
      );
      void configView?.refresh();
      return;
    }

    const client = makeClient();
    if (!client) return;

    let status: ServiceStatus | undefined;
    try {
      status = await client.getStatus();
    } catch (e) {
      void vscode.window.showErrorMessage((e as Error).message);
      return;
    }

    if (!status.running) {
      void configView?.refresh();
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Telegram integration is running (PID ${status.pid}, since ${formatSince(status.startedAt)}). Disable Cursor Supervisor and stop the service?`,
      { modal: true },
      "Stop and disable",
      "Cancel",
    );

    if (choice === "Stop and disable") {
      try {
        const msg = await client.stop();
        barState = "stopped";
        renderBar();
        void vscode.window.showInformationMessage(msg);
      } catch (e) {
        lastError = (e as Error).message;
        barState = "error";
        renderBar();
        void vscode.window.showErrorMessage(lastError);
      }
      void configView?.refresh();
      return;
    }

    ignoreEnabledChange = true;
    try {
      const target = enabledUpdateTarget();
      const folder = vscode.workspace.workspaceFolders?.[0];
      const cfg =
        target === vscode.ConfigurationTarget.WorkspaceFolder && folder
          ? vscode.workspace.getConfiguration("cursorSupervisor", folder.uri)
          : vscode.workspace.getConfiguration("cursorSupervisor");
      await cfg.update("enabled", true, target);
    } finally {
      setTimeout(() => {
        ignoreEnabledChange = false;
        void configView?.refresh();
      }, 0);
    }
  }

  async function doStart(source: "manual" | "autostart" = "manual"): Promise<void> {
    const client = makeClient();
    if (!client) {
      void vscode.window.showErrorMessage("Open a workspace folder to use Cursor Supervisor.");
      return;
    }

    const s = getSettings();
    if (!s) return;
    if (!s.enabled) {
      if (source === "manual") {
        void vscode.window.showErrorMessage(
          "Cursor Supervisor is disabled in Settings. Enable it to start the service.",
        );
      }
      return;
    }
    if (!(await workspaceHasConfig(s.configPath))) {
      if (source === "autostart") return;
      const created = await runSetupWizard(s.configPath);
      if (!created || !(await workspaceHasConfig(s.configPath))) {
        void vscode.window.showErrorMessage(
          `config.json not found at ${s.configPath}`,
        );
        barState = "error";
        lastError = "config.json not found";
        renderBar();
        return;
      }
    }

    let status: ServiceStatus | undefined;
    try {
      status = await client.getStatus();
    } catch (e) {
      barState = "error";
      lastError = (e as Error).message;
      renderBar();
      void vscode.window.showErrorMessage(lastError);
      return;
    }

    if (status.running) {
      const action = await handleRunningConflict(
        status,
        source === "autostart" ? "autostart" : "start",
      );
      if (action === "cancel" || action === "use") {
        if (action === "use") {
          barState = "running";
          renderBar(status);
        }
        return;
      }
      if (action === "restart") {
        try {
          await client.stop();
          await new Promise((r) => setTimeout(r, 500));
        } catch (e) {
          void vscode.window.showErrorMessage((e as Error).message);
          return;
        }
      }
    } else if (status.stale) {
      try {
        await client.stop();
      } catch {
        /* best effort */
      }
    }

    barState = "starting";
    renderBar();
    try {
      await client.start();
      await new Promise((r) => setTimeout(r, 800));
      const after = await client.getStatus();
      if (after.running) {
        barState = "running";
        renderBar(after);
        if (source === "manual") {
          void vscode.window.showInformationMessage(
            `Cursor Supervisor started (pid ${after.pid}).`,
          );
        }
      } else {
        barState = "error";
        lastError = "Service did not report running after start";
        renderBar();
        void vscode.window.showErrorMessage(lastError);
      }
    } catch (e) {
      barState = "error";
      lastError = (e as Error).message;
      renderBar();
      void vscode.window.showErrorMessage(lastError);
    }
    void configView?.refresh();
  }

  async function doStop(): Promise<void> {
    const client = makeClient();
    if (!client) return;
    try {
      const msg = await client.stop();
      barState = "stopped";
      renderBar();
      void vscode.window.showInformationMessage(msg);
    } catch (e) {
      barState = "error";
      lastError = (e as Error).message;
      renderBar();
      void vscode.window.showErrorMessage(lastError);
    }
    void configView?.refresh();
  }

  async function doShowStatus(): Promise<void> {
    const client = makeClient();
    if (!client) {
      void vscode.window.showInformationMessage("No workspace folder open.");
      return;
    }
    try {
      const status = await client.getStatus();
      if (status.running) {
        void vscode.window.showInformationMessage(
          `Cursor Supervisor running — PID ${status.pid}, since ${formatSince(status.startedAt)}`,
          { modal: false },
        );
      } else if (status.stale) {
        void vscode.window.showWarningMessage(
          `Stale lock (pid ${status.pid} not alive). Use Stop to clear or Start to replace.`,
        );
      } else {
        void vscode.window.showInformationMessage("Cursor Supervisor is not running.");
      }
      barState = status.running ? "running" : "stopped";
      renderBar(status);
    } catch (e) {
      void vscode.window.showErrorMessage((e as Error).message);
    }
  }

  async function doRunPrompt(): Promise<void> {
    const client = makeClient();
    if (!client) {
      void vscode.window.showErrorMessage(
        "Open a workspace folder to use Cursor Supervisor.",
      );
      return;
    }
    try {
      const status = await client.getStatus();
      if (!status.running) {
        void vscode.window.showErrorMessage(
          "Start Cursor Supervisor first, then run a prompt.",
        );
        return;
      }
    } catch (e) {
      void vscode.window.showErrorMessage((e as Error).message);
      return;
    }

    const text = await vscode.window.showInputBox({
      title: "Cursor Supervisor — Run Prompt",
      prompt: "Sent to the local agent; progress mirrors on Telegram",
      placeHolder: "Describe the task…",
      ignoreFocusOut: true,
    });
    if (text === undefined) return;
    const trimmed = text.trim();
    if (!trimmed) {
      void vscode.window.showWarningMessage("Empty prompt.");
      return;
    }

    try {
      const msg = await client.prompt({ text: trimmed });
      void vscode.window.showInformationMessage(
        msg || "Accepted — watch Telegram for progress.",
      );
    } catch (e) {
      void vscode.window.showErrorMessage((e as Error).message);
    }
  }

  async function doSetTelegramBotToken(): Promise<void> {
    const s = getSettings();
    if (!s) {
      void vscode.window.showErrorMessage(
        "Open a workspace folder to use Cursor Supervisor.",
      );
      return;
    }
    await promptAndSaveSecret({
      configPath: s.configPath,
      field: "telegram.botToken",
      title: "Telegram bot token",
      prompt: "From @BotFather (TELEGRAM_BOT_TOKEN)",
    });
    void configView?.refresh();
  }

  async function doSetCursorApiKey(): Promise<void> {
    const s = getSettings();
    if (!s) {
      void vscode.window.showErrorMessage(
        "Open a workspace folder to use Cursor Supervisor.",
      );
      return;
    }
    await promptAndSaveSecret({
      configPath: s.configPath,
      field: "cursor.apiKey",
      title: "Cursor API key",
      prompt: "From Cursor Settings or `agent login` (CURSOR_API_KEY)",
    });
    void configView?.refresh();
  }

  async function setEnabledFromView(enabled: boolean): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const cfg = folder
      ? vscode.workspace.getConfiguration("cursorSupervisor", folder.uri)
      : vscode.workspace.getConfiguration("cursorSupervisor");
    await cfg.update("enabled", enabled, vscode.ConfigurationTarget.Workspace);
  }

  async function saveSecretsFromView(input: {
    telegramBotToken: string;
    cursorApiKey: string;
  }): Promise<void> {
    const s = getSettings();
    if (!s) {
      void vscode.window.showErrorMessage(
        "Open a workspace folder to use Cursor Supervisor.",
      );
      return;
    }
    if (!(await workspaceHasConfig(s.configPath))) {
      const created = await runSetupWizard(s.configPath);
      if (!created) return;
    }
    const updated: string[] = [];
    if (input.telegramBotToken.trim()) {
      const result = await writeSecretField(
        s.configPath,
        "telegram.botToken",
        input.telegramBotToken,
      );
      if (result === "updated") updated.push("Telegram bot token");
    }
    if (input.cursorApiKey.trim()) {
      const result = await writeSecretField(
        s.configPath,
        "cursor.apiKey",
        input.cursorApiKey,
      );
      if (result === "updated") updated.push("Cursor API key");
    }
    if (updated.length === 0) {
      void vscode.window.showInformationMessage("No keys changed.");
      return;
    }
    void vscode.window.showInformationMessage(`Updated ${updated.join(" and ")}.`);
  }

  async function getViewSnapshot() {
    const s = getSettings();
    if (!s) {
      return {
        hasWorkspace: false,
        enabled: true,
        running: false,
        configExists: false,
        telegramConfigured: false,
        cursorConfigured: false,
      };
    }
    const flags = await getSecretFlags(s.configPath);
    let running = false;
    const client = makeClient();
    if (client) {
      try {
        running = (await client.getStatus()).running;
      } catch {
        running = false;
      }
    }
    return {
      hasWorkspace: true,
      enabled: s.enabled,
      running,
      configExists: flags.configExists,
      telegramConfigured: flags.telegramBotToken,
      cursorConfigured: flags.cursorApiKey,
    };
  }

  configView = new ConfigViewProvider({
    getSnapshot: getViewSnapshot,
    setEnabled: setEnabledFromView,
    saveSecrets: saveSecretsFromView,
    start: () => doStart("manual"),
    stop: () => doStop(),
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CONFIG_VIEW_ID, configView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("cursorSupervisor.start", () => doStart("manual")),
    vscode.commands.registerCommand("cursorSupervisor.stop", () => doStop()),
    vscode.commands.registerCommand("cursorSupervisor.showStatus", () => doShowStatus()),
    vscode.commands.registerCommand("cursorSupervisor.runPrompt", () => doRunPrompt()),
    vscode.commands.registerCommand(
      "cursorSupervisor.setTelegramBotToken",
      () => doSetTelegramBotToken(),
    ),
    vscode.commands.registerCommand(
      "cursorSupervisor.setCursorApiKey",
      () => doSetCursorApiKey(),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("cursorSupervisor.enabled")) return;
      void handleEnabledChanged();
    }),
  );

  renderBar();
  void refreshStatus();
  startPolling();

  void (async () => {
    const s = getSettings();
    if (!s || !s.enabled || !s.autoStart) return;
    if (!(await workspaceHasConfig(s.configPath))) return;
    const client = makeClient();
    if (!client) return;
    try {
      const status = await client.getStatus();
      if (!status.running) {
        await doStart("autostart");
      } else {
        barState = "running";
        renderBar(status);
      }
    } catch {
      /* ignore autostart errors */
    }
  })();
}

export function deactivate(): void {
  /* polling cleared via subscriptions */
}
