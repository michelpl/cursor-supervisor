# Cursor Supervisor

Drive Cursor agents on your local repos from Telegram. This extension starts, stops, and monitors the **full Telegram ↔ Cursor ACP service** on your machine.

## Requirements

- **Node.js ≥ 20.10** on your PATH
- Cursor **agent CLI** (`agent`) available for ACP
- A Telegram bot token, your numeric Telegram user ID, and a Cursor API key

Tokens stay in `~/.cursor-supervisor/config.json` (user-global, shared with the CLI). They are not uploaded with the extension.

## Usage

1. Open a project folder in Cursor.
2. Click the **Cursor Supervisor** icon in the Primary Side Bar, or Command Palette → **Cursor Supervisor: Start**
3. If `~/.cursor-supervisor/config.json` is missing, complete the setup wizard.
4. Message your bot on Telegram (`/start`).

The side bar has the enable switch, masked API key fields, and Start/Stop. Commands: **Start**, **Stop**, **Show Status**, **Set Telegram Bot Token**, **Set Cursor API Key**. Click the status bar item for a summary.

By default the service is **detached** and keeps running after you close the IDE. Use **Stop** to terminate it.

## Settings

Open **Settings** and search for **Cursor Supervisor**. The **Enable Cursor Supervisor** switch turns the extension integration on or off. If you disable it while Telegram is running, you are asked to stop the service.

Bot token and Cursor API key are edited from Settings (command links) or the Command Palette, with a masked input. Values are written to `~/.cursor-supervisor/config.json`, not to `settings.json`.

| Setting | Default |
| --- | --- |
| `cursorSupervisor.enabled` | `true` |
| `cursorSupervisor.autoStart` | `false` |
| `cursorSupervisor.configPath` | `${userHome}/.cursor-supervisor/config.json` |
| `cursorSupervisor.nodePath` | `node` |
| `cursorSupervisor.executablePath` | empty (auto: bundled server) |
| `cursorSupervisor.detach` | `true` |
| `cursorSupervisor.statusPollIntervalMs` | `5000` |

## Privacy

Bot token, API key, and chat data stay on this computer. See the repository README for security notes.

## License

MIT
