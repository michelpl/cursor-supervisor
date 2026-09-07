# Deployment Guide

Cursor Supervisor is a long-lived single Node process. To run it 24/7, hand the process to a supervisor that will:

- Restart it after crashes
- Restart it after host reboots
- Pipe logs to disk
- Honour `SIGTERM` for clean shutdowns (already implemented in `src/bin/cursor-supervisor.ts`)

This guide covers four supervisors plus a note on Docker.

- [Linux &mdash; `systemd` user unit](#linux--systemd-user-unit) (recommended for Linux)
- [pm2 (cross-platform)](#pm2-cross-platform)
- [macOS &mdash; `launchd` user agent](#macos--launchd-user-agent)
- [Windows &mdash; NSSM](#windows--nssm)
- [Docker (planned, not in this milestone)](#docker-planned)

Pick whatever you're already comfortable operating &mdash; cursor-supervisor doesn't care.

> **Single instance:** Terminal, pm2, systemd, and the Cursor IDE extension all share the same lock file (`{dataDir}/service.json`, default `~/.cursor-supervisor/data/service.json`). Only one cursor-supervisor process should run per machine. Use `cursor-supervisor status` and `cursor-supervisor stop` (or the IDE commands) to inspect or stop the service. See [EXTENSION.md](./EXTENSION.md).

---

## Build first

All deployment paths assume you've **built once**:

```bash
git clone https://github.com/michelpl/cursor-supervisor.git /opt/cursor-supervisor
cd /opt/cursor-supervisor
npm ci --omit=dev=false   # we still need devDeps for tsup at build time
npm run build             # produces dist/
```

After this, `node dist/bin/cursor-supervisor.js` is the production entry point. (No `tsx` needed in production.)

---

## Linux &mdash; `systemd` user unit

Recommended for any modern Linux distro. The service runs as **your normal user** (no root needed), survives reboots if you enable `linger`, and integrates with `journalctl` for logs.

### 1. Place the unit file

Create `~/.config/systemd/user/cursor-supervisor.service`:

```ini
[Unit]
Description=cursor-supervisor &mdash; Telegram <-> Cursor SDK bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/cursor-supervisor
ExecStart=/usr/bin/node %h/cursor-supervisor/dist/bin/cursor-supervisor.js
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15

# Pass secrets from a separate, root-readable-only file
EnvironmentFile=%h/.config/cursor-supervisor/env

# Tighten permissions a bit
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

### 2. Place secrets

```bash
mkdir -p ~/.config/cursor-supervisor
chmod 700 ~/.config/cursor-supervisor
cat > ~/.config/cursor-supervisor/env <<'EOF'
TELEGRAM_BOT_TOKEN=123456:AA...
CURSOR_API_KEY=key_...
EOF
chmod 600 ~/.config/cursor-supervisor/env
```

### 3. Enable and start

```bash
# Allow user services to run without an active login session
sudo loginctl enable-linger $USER

# Reload systemd, enable & start
systemctl --user daemon-reload
systemctl --user enable --now cursor-supervisor.service

# Check status & logs
systemctl --user status cursor-supervisor.service
journalctl --user -u cursor-supervisor.service -f
```

To upgrade after a `git pull`:

```bash
cd ~/cursor-supervisor
git pull
npm ci
npm run build
systemctl --user Restart Cursor Supervisor.service
```

---

## pm2 (cross-platform)

`pm2` works the same on Linux, macOS, and native Windows. Best when you're already using pm2 for other Node services.

### 1. Install pm2

```bash
npm install -g pm2
```

### 2. Start cursor-supervisor under pm2

```bash
cd /path/to/cursor-supervisor
pm2 start dist/bin/cursor-supervisor.js \
  --name cursor-supervisor \
  --kill-timeout 10000 \
  --update-env

pm2 logs cursor-supervisor
pm2 status
```

### 3. Persist across reboots

```bash
pm2 save                # remember current list
pm2 startup             # follow the printed command (sudo systemctl enable ...)
```

### Optional: ecosystem file

For repeatable config, put this at the repo root as `ecosystem.config.cjs`:

```js
module.exports = {
  apps: [
    {
      name: 'cursor-supervisor',
      script: './dist/bin/cursor-supervisor.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      kill_timeout: 10000,
      env_file: './.env',
    },
  ],
};
```

Then `pm2 start ecosystem.config.cjs`.

---

## macOS &mdash; `launchd` user agent

`launchd` is macOS's native equivalent of systemd. A user agent runs only when you're logged in (and survives logout if you `launchctl bootstrap` it system-wide; we'll keep it user-scoped here).

### 1. Place the plist

Create `~/Library/LaunchAgents/com.michelpl.cursor-supervisor.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.michelpl.cursor-supervisor</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/jem/cursor-supervisor/dist/bin/cursor-supervisor.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/jem/cursor-supervisor</string>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>EnvironmentVariables</key>
  <dict>
    <key>TELEGRAM_BOT_TOKEN</key>
    <string>123456:AA...</string>
    <key>CURSOR_API_KEY</key>
    <string>key_...</string>
  </dict>

  <key>StandardOutPath</key>
  <string>/Users/jem/Library/Logs/cursor-supervisor.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/jem/Library/Logs/cursor-supervisor.err.log</string>
</dict>
</plist>
```

> Adjust `/opt/homebrew/bin/node` to wherever `which node` shows on your machine. On Intel macs it's typically `/usr/local/bin/node`.

### 2. Load it

```bash
launchctl load -w ~/Library/LaunchAgents/com.michelpl.cursor-supervisor.plist
launchctl list | grep cursor-supervisor
tail -f ~/Library/Logs/cursor-supervisor.out.log
```

To stop / unload:

```bash
launchctl unload -w ~/Library/LaunchAgents/com.michelpl.cursor-supervisor.plist
```

> Putting secrets in a plist on disk means anyone who can read your home directory can read them. For better hygiene, write a wrapper shell script that `source`s a `chmod 600` env file, then call **that** from `ProgramArguments`.

---

## Windows &mdash; NSSM

[NSSM](https://nssm.cc/) (the Non-Sucking Service Manager) wraps any executable into a real Windows Service. Useful when you want cursor-supervisor to start at boot regardless of whether anyone has logged in.

### 1. Install NSSM

Download from <https://nssm.cc/>, unzip, and either put `nssm.exe` on your PATH or run it from its own folder.

### 2. Install the service

In an **elevated** PowerShell (Run as Administrator):

```powershell
nssm install cursor-supervisor
```

In the dialog that pops up:

- **Application** tab:
  - **Path**: `C:\Program Files\nodejs\node.exe`
  - **Startup directory**: `C:\path\to\cursor-supervisor`
  - **Arguments**: `dist\bin\cursor-supervisor.js`

- **Details** tab: friendly description

- **Environment** tab: add lines (one var per line)
  ```
  TELEGRAM_BOT_TOKEN=123456:AA...
  CURSOR_API_KEY=key_...
  ```

- **I/O** tab: optional &mdash; redirect stdout/stderr to files like `C:\ProgramData\cursor-supervisor\out.log`.

- **Exit actions** tab:
  - On exit: **Restart application**
  - Throttle: 5000 ms
  - Restart delay: 5000 ms

Click **Install service**.

### 3. Start it

```powershell
Start-Service cursor-supervisor
Get-Service cursor-supervisor

# Logs (if you redirected I/O):
Get-Content C:\ProgramData\cursor-supervisor\out.log -Wait
```

To remove later:

```powershell
nssm remove cursor-supervisor confirm
```

> Alternative: just run `pm2-windows-service` &mdash; it's effectively pm2 + NSSM glued together.

---

## Docker (planned)

Not in this milestone. The two reasons it isn't trivial:

1. **Host filesystem access**. Cursor Supervisor drives Cursor agents over your **local** repos. Inside a container, you'd have to bind-mount each workspace, set permissions correctly, and resolve symlinks. Doable, but no longer a one-liner.
2. **Cursor SDK sub-processes**. The agent's shell tool currently spawns processes inside the same OS environment as cursor-supervisor. Inside a container, that means everything the agent does (including `git`, `npm`, `python`...) has to be installed in the image. Convenient for a CI job, less convenient for "drive my desktop".

A future image will probably ship as a **container with the SDK pre-installed**, plus a documented `--mount` recipe for binding host workspaces. Until then, run cursor-supervisor as a native process.

---

## Health check

Whichever supervisor you pick, after start-up you should:

1. See structured logs containing `Bot connected as @your_bot`.
2. In Telegram, send `/status` to your bot &mdash; expect a quick reply.
3. (Optional) Trigger one round-trip: send a tiny prompt like `pwd`, see the reply within a few seconds.

If any of these fail, check **[FAQ.md](./FAQ.md)** or the supervisor's own log channel:

| Supervisor | Log command |
| --- | --- |
| systemd | `journalctl --user -u cursor-supervisor.service -e` |
| pm2 | `pm2 logs cursor-supervisor` |
| launchd | `tail -f ~/Library/Logs/cursor-supervisor.out.log` |
| NSSM | `Get-Content C:\ProgramData\cursor-supervisor\out.log -Wait` |
