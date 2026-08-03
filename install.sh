#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(command -v node || true)"
UNIT_DIR="$HOME/.config/systemd/user"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/focus-nudge"

if [ -z "$NODE" ]; then
  echo "install: node is not on PATH" >&2
  echo "  this tool needs Node >= 22: https://nodejs.org/" >&2
  exit 1
fi

# Pre-flight every prerequisite BEFORE touching systemd. Starting the unit is
# the riskiest, least reversible step, so nothing that can fail may come after
# it — otherwise a failure leaves the daemon running with no `focus` command.
if [ ! -f "$REPO/cli/focus" ]; then
  echo "install: $REPO/cli/focus is missing — nothing to link" >&2
  exit 1
fi

# A missing systemd user session is the single most likely failure on a
# stranger's machine (a bare SSH box, a container, WSL without systemd
# enabled, ...), and without this check the script would get most of the way
# through — config dir, quotes, symlink — before failing on the unit itself.
if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "install: 'systemctl --user' does not work on this machine" >&2
  echo "  this tool needs Linux with a systemd user session (not macOS, not Windows," >&2
  echo "  and not every container/WSL setup). See: systemctl --user status" >&2
  exit 1
fi

# Node existing is not enough: an old Node installs cleanly and then fails at
# runtime on node:test, global fetch, or AbortSignal.timeout in ways that look
# like bugs in this tool rather than an unmet prerequisite.
NODE_MAJOR="$("$NODE" -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || true)"
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    echo "install: could not determine node's version (node --version reports: $("$NODE" --version 2>&1))" >&2
    exit 1
    ;;
esac
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "install: node is too old ($("$NODE" --version), need >= 22)" >&2
  echo "  upgrade Node: https://nodejs.org/" >&2
  exit 1
fi

# Chrome/Chromium and notify-send are warnings, not hard failures: someone may
# install Chrome afterwards, and the daemon already degrades gracefully with
# no notify-send.
if ! command -v google-chrome >/dev/null 2>&1 \
  && ! command -v google-chrome-stable >/dev/null 2>&1 \
  && ! command -v chromium >/dev/null 2>&1; then
  echo "warning: no Chrome/Chromium found on PATH — the extension needs Google Chrome" >&2
fi
if ! command -v notify-send >/dev/null 2>&1; then
  echo "warning: notify-send not found — desktop notifications will be silently skipped" >&2
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

echo "==> linking the focus command into $BIN_DIR"
mkdir -p "$BIN_DIR"
chmod +x "$REPO/cli/focus"
ln -sf "$REPO/cli/focus" "$BIN_DIR/focus"

echo "==> installing the systemd user unit"
mkdir -p "$UNIT_DIR"
sed -e "s|__NODE__|$NODE|g" -e "s|__REPO__|$REPO|g" \
  "$REPO/systemd/focus-nudge.service" > "$UNIT_DIR/focus-nudge.service"
systemctl --user daemon-reload

# `enable --now` starts a stopped unit but is a no-op on a running one, so a
# reinstall after node moved or the repo was relocated would leave the live
# process on a stale ExecStart. Restart explicitly when it is already up so the
# running daemon always matches the unit file on disk.
if systemctl --user is-active --quiet focus-nudge.service; then
  echo "    already running — restarting to pick up the rendered unit"
  systemctl --user enable focus-nudge.service
  systemctl --user restart focus-nudge.service
else
  systemctl --user enable --now focus-nudge.service
fi

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
