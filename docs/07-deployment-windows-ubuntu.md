# 07 — Deployment: Windows & Ubuntu / Ubuntu Server

Mirais runs the same everywhere: **Bun + one port (`1463`) + one data directory**. By default it binds to **`0.0.0.0`** so it is reachable from LAN / Tailscale / internet depending on your firewall.

> Security rule: if `HOST=0.0.0.0`, `::`, or any non-loopback address, `DASHBOARD_PASSWORD` must be set. Passwordless dashboard mode is allowed only on loopback (`127.0.0.1`, `::1`, `localhost`).

---

## 1. Prerequisites (both OS)

| Requirement | Windows | Ubuntu |
|---|---|---|
| Bun ≥ 1.1 | `powershell -c "irm bun.sh/install.ps1 \| iex"` | `curl -fsSL https://bun.sh/install \| bash` |
| Git | git-scm.com | `sudo apt install -y git` |
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
HOST=0.0.0.0             # exposed binding; requires DASHBOARD_PASSWORD
DATA_DIR=./data
DASHBOARD_PASSWORD=<strong-password>
SESSION_SECRET=<64 random hex chars>   # generate: bun -e "console.log(crypto.getRandomValues(new Uint8Array(32)).reduce((s,b)=>s+b.toString(16).padStart(2,'0'),''))"
```

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
mirais update
mirais fix          # force update/install/build/start from remembered install root
mirais doctor       # diagnose and repair safe installation issues
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
      HOST: 0.0.0.0
      DATA_DIR: /app/data
      DASHBOARD_PASSWORD: ${DASHBOARD_PASSWORD}
      SESSION_SECRET: ${SESSION_SECRET}
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
curl -X POST http://localhost:1463/api/auth/login \
  -H "Content-Type: application/json" -d "{\"password\":\"$DASHBOARD_PASSWORD\"}" -c - 
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
| Update | `git pull && bun install && (cd dashboard && bun install) && bun run build && restart service` |
| Repair stale install / bad root | `mirais fix` |
| Backup | Dashboard → Settings → Data → **Backup now** (or `bun run scripts/backup.ts`, cron it) |
| Logs | journalctl / `data/service.log` / in-app Logs page |
| Reset password | stop → delete `dashboard_password_hash` from `settings` table (sqlite3 CLI) → start → setup screen appears |
| Monitor | `/health` from Uptime Kuma etc.; disk space of `DATA_DIR` |

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE :1463` | Another instance/app on the port → change `PORT` or stop it (`netstat -ano \| findstr 1463` / `ss -ltnp \| grep 1463`) |
| `Refusing to start: no dashboard password is set and HOST=0.0.0.0 is not loopback` | Either set `DASHBOARD_PASSWORD` in `.env` and restart, or run `mirais expose off` for loopback-only passwordless mode |
| Login loop | `SESSION_SECRET` changed or cookie blocked; check HTTPS vs http `Secure` cookie |
| All providers 401 | Re-enter upstream API keys; check clock skew (OAuth) |
| DB locked | Two processes on same `DATA_DIR` — run only one |
| Windows Defender slow scan | Exclude project & `DATA_DIR` folders |
