# ACP end-to-end manual checklist

Prerequisites: Cursor CLI `agent` on PATH, valid `config.json`, Telegram bot token.

## Boot

- [ ] `npm run build && npm start` — bot starts without SDK errors
- [ ] Log shows `Cursor Supervisor started (ACP mode)`

## Workspace

- [ ] `/wslist` — shows default workspace
- [ ] `/status` — shows session ACP id, mode, and plan status after first prompt

## Prompt

- [ ] Send plain text — streams assistant reply (no forced mode change)
- [ ] Send `!` prefixed text while busy — force-replaces run

## ACP modes (plan → execute)

- [ ] `/plan <tarefa>` — switches to plan mode, streams response
- [ ] Plan request shows full plan text + **Aprovar e guardar** / **Rejeitar**
- [ ] Approve-save → "Plan saved" message
- [ ] `/agent` — "Mode agent is active" without running a prompt
- [ ] `/agent execute the plan` — injects saved plan and executes
- [ ] Completion message sent separately ("Plano concluído" / "Execução concluída")

## Interactions (requires agent tool approval)

- [ ] Agent requests shell permission — alert + inline buttons appear
- [ ] Tap **Permitir uma vez** — run continues
- [ ] Agent asks question — alert + buttons or free-text reply works

## Images & attachments

- [ ] Send photo with caption — agent receives image
- [ ] Agent uses attach CLI — file arrives in Telegram after run

## Commands

- [ ] `/cancel` — cancels active run
- [ ] `/reset` — clears session, new sessionId on next prompt
- [ ] `/remind add text 5m teste` — delivers reminder text

## Cutover gate

```bash
npm test && npm run typecheck && npm run lint && npm run build
```
