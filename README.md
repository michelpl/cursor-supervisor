# Cursor Supervisor

Cursor Supervisor is a local service that lets you drive **Cursor agents on your own machine** from a **Telegram** chat.

You install it on the computer where your repos already live. The bot is only a remote control: prompts, approvals, and file drops go through Telegram; the agent still runs next to your code, using Cursor ACP (`agent acp`). Nothing in this project hosts your source on a third-party coding server.

## What you get

- A Telegram bot that talks to the Cursor agent already authenticated on your PC
- Interactive buttons for tool permissions, questions, and plan approval
- Multiple local workspaces (`/wsadd`, `/ws use`)
- Photos in, files out (`cursor-supervisor-attach-image` / `cursor-supervisor-attach-file`)
- Optional reminders that either ping you or fire a prompt at the agent
- An allow-list: only the Telegram user IDs you configure can talk to the bot
- A Cursor IDE extension that starts/stops the same process without a dedicated terminal

One process per machine. CLI, systemd/pm2, and the extension share `{dataDir}/service.json` (default `~/.cursor-supervisor/data/service.json`) so you do not accidentally run two bots.

## Install

### From Cursor (intended path)

1. Node.js **20.10+** on your PATH
2. Cursor **agent CLI** available (`agent`)
3. Install **Cursor Supervisor** (`michelpl.cursor-supervisor`) from the Cursor extensions panel once it is on Open VSX, or `Install from VSIX…` using `npm run extension:package`
4. Open a project folder → **Cursor Supervisor: Start**
5. If there is no config, complete the setup wizard (bot token, Cursor API key, your Telegram user ID)

The extension ships the Telegram service inside the VSIX. Config and runtime data live in the **user-global** folder `~/.cursor-supervisor/` (shared by the CLI and the extension), not inside the extension install.

Until the listing is live, package locally:

```bash
npm install
npm run extension:package
```

Details: [docs/EXTENSION.md](docs/EXTENSION.md), [docs/MARKETPLACE.md](docs/MARKETPLACE.md).

### From source (CLI)

```bash
git clone https://github.com/michelpl/cursor-supervisor.git
cd cursor-supervisor
npm install
mkdir -p ~/.cursor-supervisor
cp config.example.json ~/.cursor-supervisor/config.json
```

Set `telegram.botToken`, `telegram.allowedUserIds`, and `cursor.apiKey` (or `TELEGRAM_BOT_TOKEN` / `CURSOR_API_KEY`). Then:

```bash
npm run build
npm start
```

Walkthrough: [docs/INSTALL.md](docs/INSTALL.md). Tokens and IDs: [docs/PREREQUISITES.md](docs/PREREQUISITES.md). Running 24/7: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Telegram commands

| Command | Purpose |
| --- | --- |
| `/help` | Command list |
| `/wslist` / `/ws use` / `/wsadd` / `/ws remove` / `/ws path` | Local repos |
| `/plan <task>` | Plan mode |
| `/agent` / `/agent <prompt>` | Agent mode (`/agent execute the plan` uses a saved plan) |
| `/ask <question>` | Read-only ask mode |
| `/cancel` / `!<text>` | Stop the current run / interrupt with a new prompt |
| `/reset` | New ACP session |
| `/status` | Workspace, session, mode, saved plan |
| `/remind …` | Text or agent-prompt reminders |

Plain messages are prompts. Prefix with `!` to cancel whatever is running and start over.

## Security

This is a remote shell into **your** machine. Treat it that way.

- Keep `~/.cursor-supervisor/config.json` (and any local copies) out of git
- `.cursorignore` / `.cursorindexingignore` keep workspace `.cursor-supervisor/` markers away from Cursor agents and indexing
- Outbound Telegram text and logs redact bare bot tokens and Cursor API keys
- The ACP child process does **not** inherit `TELEGRAM_BOT_TOKEN` (or lookalike env values)
- Put **only your** numeric Telegram IDs in `allowedUserIds`
- Do not run the process as root
- Rotate the bot token immediately if it may have leaked; prefer a neutral bot name (avoid brand names like “Cursor”)

## Development

```bash
npm test
npm run typecheck
npm run lint
```

Contributing: [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md). Common failures: [docs/FAQ.md](docs/FAQ.md).

## License

[MIT](LICENSE) © Michel Lima
