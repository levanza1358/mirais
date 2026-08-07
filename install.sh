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

echo "[mirais] installing prerequisites"
if ! need_cmd git; then
  sudo apt-get update
  sudo apt-get install -y git curl unzip
fi

if ! need_cmd bun; then
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${HOME}/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

echo "[mirais] cloning/updating repo"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only origin main
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  rm -rf "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

echo "[mirais] installing dependencies"
bun install
(cd dashboard && bun install)

echo "[mirais] preparing environment"
if [ ! -f .env ]; then
  cp .env.example .env
fi
mkdir -p data/backups

echo "[mirais] building dashboard"
bun run build

echo "[mirais] installing CLI shortcut"
mkdir -p "$HOME/.config/mirais"
cat > "$HOME/.config/mirais/install.json" <<JSON
{"root":"$INSTALL_DIR"}
JSON
sudo ln -sf "$INSTALL_DIR/mirais" /usr/local/bin/mirais
sudo chmod +x "$INSTALL_DIR/mirais"

echo "[mirais] installing optional runtime helpers (yt-dlp, ffmpeg) for the Music player"
if bun run scripts/extras.ts 2>&1 | sed 's/^/  /'; then :; else
  echo "  (optional helpers could not be installed — Music will fall back to public Invidious instances)"
fi

echo
echo "Mirais installed. Next commands:"
echo "  mirais start"
echo "  mirais autostart on"
echo "  mirais status"