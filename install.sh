#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${MIRAIS_REPO_URL:-https://github.com/levanza1358/mirais.git}"
if [ "$(id -u)" -eq 0 ]; then
  DEFAULT_INSTALL_DIR="/opt/mirais"
else
  DEFAULT_INSTALL_DIR="$HOME/mirais"
fi
INSTALL_DIR="${MIRAIS_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

echo "Installation in progress... please wait."
if ! need_cmd git; then
  sudo apt-get update >/dev/null
  sudo apt-get install -y git curl unzip >/dev/null
fi

if ! need_cmd bun; then
  curl -fsSL https://bun.sh/install | bash >/dev/null
  export BUN_INSTALL="${HOME}/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only origin main >/dev/null
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  rm -rf "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR" >/dev/null
fi

cd "$INSTALL_DIR"

bun install >/dev/null
(cd dashboard && bun install >/dev/null)

if [ ! -f .env ]; then
  cp .env.example .env
fi
mkdir -p data/backups

bun run build >/dev/null

mkdir -p "$HOME/.config/mirais"
cat > "$HOME/.config/mirais/install.json" <<JSON
{"root":"$INSTALL_DIR"}
JSON
sudo ln -sf "$INSTALL_DIR/mirais" /usr/local/bin/mirais
sudo chmod +x "$INSTALL_DIR/mirais"

# Optional: install yt-dlp / ffmpeg extras (audio + video discovery). Run
# `bun run extras` any time later if you skipped it here.
if [ "${MIRAIS_INSTALL_EXTRAS:-1}" = "1" ]; then
  bun run scripts/extras.ts >/dev/null 2>&1 || echo "extras install failed (non-fatal); run 'bun run extras' later"
fi

echo "Installation successful. Check dashboard at http://localhost:1463"