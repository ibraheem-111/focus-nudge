#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(command -v node || true)"
UNIT_DIR="$HOME/.config/systemd/user"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/focus-nudge"

if [ -z "$NODE" ]; then
  echo "install: node is not on PATH" >&2
  exit 1
fi

echo "==> creating $CONFIG_DIR"
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/quotes.txt" ]; then
  cat > "$CONFIG_DIR/quotes.txt" <<'EOF'
# One quote per line, as: text — author
# The author is optional. Lines starting with # are ignored.
# These are added to the list bundled with the extension.
EOF
  echo "    wrote a starter quotes.txt"
else
  echo "    quotes.txt already exists, leaving it alone"
fi

echo "==> installing the systemd user unit"
mkdir -p "$UNIT_DIR"
sed -e "s|__NODE__|$NODE|g" -e "s|__REPO__|$REPO|g" \
  "$REPO/systemd/focus-nudge.service" > "$UNIT_DIR/focus-nudge.service"
systemctl --user daemon-reload
systemctl --user enable --now focus-nudge.service

echo "==> linking the focus command into $BIN_DIR"
mkdir -p "$BIN_DIR"
chmod +x "$REPO/cli/focus"
ln -sf "$REPO/cli/focus" "$BIN_DIR/focus"

sleep 1
if "$BIN_DIR/focus" status >/dev/null 2>&1; then
  echo "==> daemon is up"
  "$BIN_DIR/focus" status
else
  echo "!! the daemon did not answer. Check: systemctl --user status focus-nudge" >&2
  exit 1
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on your PATH. Add it to ~/.bashrc." ;;
esac

cat <<EOF

One step left — load the extension:
  1. open chrome://extensions
  2. turn on Developer mode
  3. click "Load unpacked" and choose:
       $REPO/extension
EOF
