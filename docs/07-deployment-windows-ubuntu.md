# 07 — Deployment: Windows & Ubuntu / Ubuntu Server

Mirais runs the same everywhere: **Bun + one port (`1463`) + one data directory**. By default it binds to **`0.0.0.0`** so it is reachable from LAN / Tailscale / internet depending on your firewall.

> The Mirais dashboard is password-protected by default (`12345678` — change it in Settings → General, or preset it with `DASHBOARD_PASSWORD`). It guards the dashboard only; gateway clients on `/v1/*` keep using gateway API keys. Even with a password, when exposed beyond a trusted network bind it to `127.0.0.1` and protect access with an authenticated reverse proxy, VPN, firewall, or private network. Do not expose port `1463` directly to the internet.

---

## 1. Prerequisites (both OS)

| Requirement | Windows | Ubuntu |
|---|---|---|
| Bun ≥ 1.1 | `powershell -c "irm bun.sh/install.ps1 \| iex"` | `curl -fsSL https://bun.sh/install \| bash` |
| Git | git-scm.com | `sudo apt install -y git` |
| Python 3 | python.org | `sudo apt install -y python3 python3-venv` |
| (optional) Docker | Docker Desktop | `sudo apt install -y docker.io docker-compose-v2` |

Verify: `bun --version`

## 2. Get & Configure

### Fast path — one-shot installers

Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/levanza1358/mirais/main/install.sh | bash
mirais start
mirais autostart on
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/levanza1358/mirais/main/install.ps1 | iex
mirais start
mirais autostart on
```

The Windows installer automatically opens a UAC prompt and relaunches itself
with administrator access. Administrator access is used to install the global
`mirais` command in `C:\Windows`; no manually elevated PowerShell window is
required.

**Install locations.** Windows installs to `%USERPROFILE%\Mirais`
(`C:\Users\<you>\Mirais`); Ubuntu uses `$HOME/mirais`, or `/opt/mirais` when run
as root. Set `MIRAIS_INSTALL_DIR` to override:

```powershell
$env:MIRAIS_INSTALL_DIR = 'D:\Mirais'
irm https://raw.githubusercontent.com/levanza1358/mirais/main/install.ps1 | iex
```

Since the UAC relaunch starts a fresh process, pass an override as a machine or
user environment variable (`setx MIRAIS_INSTALL_DIR D:\Mirais`) rather than a
session variable, or run the installer from an already-elevated shell.

Both one-shot installers create an isolated Python environment at
`<install-root>/.venv` and store the Camoufox browser at
`<install-root>/.camoufox`. Farm never installs packages into global Python.

### Manual path

```bash
git clone <your-repo> mirais && cd mirais
bun install
cd dashboard && bun install && cd ..
bun run build            # builds dashboard into dashboard/dist
cp .env.example .env     # Windows: copy .env.example .env
```

Edit `.env`:

```bash
PORT=1463
HOST=127.0.0.1           # recommended behind a reverse proxy
DATA_DIR=/opt/mirais/data   # ⚠️ use an absolute path on VPS, not "./data"
```

> **`DATA_DIR` matters.** If you leave it as `./data`, the SQLite file lands
> wherever the process was started from. On `mirais start` (the bundled
> CLI) this is the install root, so it Just Works. But if you run via
> `systemd`, `pm2`, `docker`, or any launcher that doesn't `cd` into the
> install root first, `./data` may resolve to `/data`, `/`, or another
> unexpected path — and the dashboard will show an empty database while
> the real one lives somewhere else. Always set an absolute path on VPS
> deployments and confirm with `curl http://127.0.0.1:1463/api/health`
> (the response now reports the resolved `data_dir` and `db_path`).
> Mirais also logs a `WARNING` at startup if `DATA_DIR` resolves to
> `/data` so the symptom doesn't get blamed on the dashboard.

---

## 3A. Windows — Run as your user

**Foreground (dev/simple):**
```powershell
bun run start
# Dashboard: http://localhost:1463  ·  API: http://localhost:1463/v1
```

**Background (built-in CLI — no extra tools):**
```powershell
mirais start      # detached background process; logs → data\mirais.log; pid → data\mirais.pid
mirais status     # exit 0 = healthy, 1 = process up but unhealthy, 3 = not running
mirais restart
mirais stop
mirais autostart on
mirais autostart off
mirais autostart status
mirais update     # shows old → new version, clears caches, updates, rebuilds, and restarts
mirais fix          # force update/install/build/start from remembered install root
mirais doctor       # diagnose and repair safe installation issues
mirais doctor --json # same checks, machine-readable output for monitoring
mirais doctor --fix # run the full repair flow
mirais uninstall --yes  # permanently removes the install, data, backups, and autostart entry
mirais expose off  # switch back to localhost-only; restart required
```
(Equivalents: `bun run mirais start`, `bun run svc:start|svc:stop|svc:restart|svc:status`.)

**Background service (recommended for auto-start on boot) — NSSM:**
```powershell
winget install nssm
nssm install Mirais "C:\Users\<you>\.bun\bin\bun.exe" "run start"
nssm set Mirais AppDirectory "C:\path\to\mirais"
nssm set Mirais AppStdout "C:\path\to\mirais\data\service.log"
nssm set Mirais AppStderr "C:\path\to\mirais\data\service.log"
nssm start Mirais
```
Alternative without extra tools: **Task Scheduler** → trigger "At log on", action `bun.exe run start`, start-in = project folder.

**From the dashboard:** Settings → General → "Start on boot" toggles the same mechanism (`mirais autostart`). On Windows it writes a launcher to the per-user Startup folder, so Mirais starts after you log in — no elevation needed. On Linux it writes the systemd unit, which starts at boot with no login; the toggle is disabled with an explanation when the server has neither root nor passwordless sudo.

**Firewall:** first listen may prompt — allow "Private networks". If you keep `HOST=127.0.0.1` no inbound rule is needed.

**Data location:** `%CD%\data` (contains `mirais.db` + logs). Back it up with the dashboard's "Backup now" or by copying the folder while stopped.

## 3B. Ubuntu / Ubuntu Server — systemd service

**Manual background (built-in CLI):**
```bash
./mirais start      # or: bun run mirais start
./mirais status
./mirais restart
./mirais stop
mirais autostart on
mirais autostart off
mirais autostart status
mirais update
mirais doctor
mirais uninstall --yes  # permanently removes the install, data, backups, and autostart entry
mirais expose off
```

**Auto-start on boot — systemd:**

```bash
sudo useradd --system --home /opt/mirais --shell /usr/sbin/nologin mirais
sudo mkdir -p /opt/mirais && sudo chown mirais:mirais /opt/mirais
# copy the project (or git clone) into /opt/mirais, then:
cd /opt/mirais && sudo -u mirais bun install && sudo -u mirais bash -c 'cd dashboard && bun install'
sudo -u mirais bun run build
sudo -u mirais cp .env.example .env    # then edit secrets
sudo chmod 700 /opt/mirais/data
```

`/etc/systemd/system/mirais.service`:
```ini
[Unit]
Description=Mirais AI Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mirais
WorkingDirectory=/opt/mirais
ExecStart=/home/mirais/.bun/bin/bun run start
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
# Hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mirais
systemctl status mirais
journalctl -u mirais -f        # logs
```

**Expose to LAN (optional):** set `HOST=0.0.0.0` in `.env`, then
```bash
sudo ufw allow 1463/tcp
```
**HTTPS (optional):** put Caddy/Nginx in front:
```caddy
mirais.example.com {
    reverse_proxy 127.0.0.1:1463
}
```
Keep `HOST=127.0.0.1` when behind a reverse proxy.

## 3C. Docker (both OS)

`Dockerfile` (multi-stage: build dashboard → slim runtime):

```dockerfile
FROM oven/bun:1 AS dashboard
WORKDIR /app
COPY dashboard/package.json dashboard/bun.lock* ./dashboard/
RUN cd dashboard && bun install --frozen-lockfile
COPY dashboard ./dashboard
RUN cd dashboard && bun run build

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY scripts ./scripts
COPY --from=dashboard /app/dashboard/dist ./dashboard/dist
RUN useradd -m mirais && mkdir -p /app/data && chown -R mirais /app
USER mirais
EXPOSE 1463
VOLUME ["/app/data"]
CMD ["bun", "run", "src/server.ts"]
```

`docker-compose.yml`:
```yaml
services:
  mirais:
    build: .
    ports:
      - "1463:1463"          # use "127.0.0.1:1463:1463" on public servers
    environment:
      PORT: 1463
      HOST: 127.0.0.1
      DATA_DIR: /app/data
    volumes:
      - mirais-data:/app/data
    restart: unless-stopped

volumes:
  mirais-data:
```

```bash
docker compose up -d --build
curl http://localhost:1463/health
```

---

## 4. Post-deploy Verification

```bash
bun run smoke                              # or manually:
curl http://localhost:1463/health          # → {"status":"ok",...}
curl http://localhost:1463/api/health
```
Then in the dashboard: add a provider → **Test** → create an API key → run a real completion:
```bash
curl http://localhost:1463/v1/chat/completions \
  -H "Authorization: Bearer mirais-XXXX" \
  -H "Content-Type: application/json" \
  -d '{"model":"<your-model>","messages":[{"role":"user","content":"ping"}]}'
```

## 5. Operations

| Task | How |
|---|---|
| Update | `git pull && clear Bun/package/build caches && bun install && (cd dashboard && bun install) && bun run build && restart service` |
| Repair stale install / bad root | `mirais fix` |
| Backup | Dashboard → Settings → Data → **Backup now** (or `bun run scripts/backup.ts`, cron it) |
| Logs | journalctl / `data/service.log` / in-app Logs page |
| Dashboard access | Protect the reverse proxy, firewall, VPN, or private network; Mirais has no application-level dashboard password |
| Monitor | `/health` from Uptime Kuma etc.; disk space of `DATA_DIR` |

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE :1463` | Another instance/app on the port → change `PORT` or stop it (`netstat -ano \| findstr 1463` / `ss -ltnp \| grep 1463`) |
| Dashboard reachable publicly | Bind `HOST=127.0.0.1`, remove direct port exposure, and configure authenticated reverse-proxy or VPN access |
| All providers 401 | Re-enter upstream API keys; check clock skew (OAuth) |
| DB locked | Two processes on same `DATA_DIR` — run only one |
| Windows Defender slow scan | Exclude project & `DATA_DIR` folders |
