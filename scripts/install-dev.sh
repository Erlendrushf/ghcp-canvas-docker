#!/usr/bin/env bash
# Symlinks this checkout into the user-scope Copilot extensions folder for development.
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)"
dest="${COPILOT_EXTENSIONS_DIR:-$HOME/.copilot/extensions}/docker-canvas"
mkdir -p "$(dirname "$dest")"
if [ -e "$dest" ] && [ ! -L "$dest" ]; then
  echo "Refusing to replace non-symlink $dest" >&2
  exit 1
fi
ln -sfn "$src" "$dest"
echo "Linked $dest -> $src"
echo "Start a new Copilot session (or restart the app) to load the extension."
