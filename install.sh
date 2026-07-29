#!/usr/bin/env sh
# Install context-gauge to ~/.local/bin (+ claude-context-gauge shim) and print wiring snippets.
# Idempotent; no dependencies beyond a POSIX shell + Python 3.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SRC="${ROOT}/context-gauge"
DEST_DIR="${HOME}/.local/bin"
DEST="${DEST_DIR}/context-gauge"
SHIM="${DEST_DIR}/claude-context-gauge"

if ! command -v python3 >/dev/null 2>&1; then
  echo "warning: python3 not found on PATH — the gauge needs it at runtime." >&2
fi

if [ ! -f "$SRC" ]; then
  echo "error: $SRC missing" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
install -m 755 "$SRC" "$DEST"
# shim keeps old installs / docs working
ln -sfn "$DEST" "$SHIM"
# optional: gaius-flavored name used in kub0 wiring
ln -sfn "$DEST" "${DEST_DIR}/gaius-context-gauge-grok" 2>/dev/null || true

echo "installed: $DEST"
echo "shim:      $SHIM -> $DEST"

case ":${PATH}:" in
  *":${DEST_DIR}:"*) : ;;
  *) echo "note: ${DEST_DIR} is not on your PATH — add it, or use the absolute path below." >&2 ;;
esac

cat <<EOF

Quick check:
  $DEST --self-test

── Claude Code (~/.claude/settings.json) ──

  "statusLine": { "type": "command", "command": "$DEST", "padding": 0 },

  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "$DEST" } ] }
    ]
  }

── Grok Build (~/.grok/hooks/context-gauge.json) ──

  {
    "hooks": {
      "UserPromptSubmit": [
        { "hooks": [ { "type": "command", "command": "$DEST", "timeout": 5 } ] }
      ],
      "SessionStart": [
        { "hooks": [ { "type": "command", "command": "$DEST", "timeout": 5 } ] }
      ],
      "PostCompact": [
        { "hooks": [ { "type": "command", "command": "$DEST", "timeout": 5 } ] }
      ]
    }
  }

See settings.example.json and hooks.grok.example.json.
EOF
