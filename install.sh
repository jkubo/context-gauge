#!/usr/bin/env sh
# Install claude-context-gauge to ~/.local/bin and print the settings.json snippet.
# Idempotent; no dependencies beyond a POSIX shell + Python 3 (which the script needs).
set -eu

SRC="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/claude-context-gauge"
DEST_DIR="${HOME}/.local/bin"
DEST="${DEST_DIR}/claude-context-gauge"

if ! command -v python3 >/dev/null 2>&1; then
  echo "warning: python3 not found on PATH — the gauge needs it at runtime." >&2
fi

mkdir -p "$DEST_DIR"
install -m 755 "$SRC" "$DEST"
echo "installed: $DEST"

case ":${PATH}:" in
  *":${DEST_DIR}:"*) : ;;
  *) echo "note: ${DEST_DIR} is not on your PATH — add it, or use the absolute path below." >&2 ;;
esac

cat <<EOF

Quick check:
  $DEST --self-test

Then add to ~/.claude/settings.json (statusLine, the UserPromptSubmit hook, or both):

  "statusLine": { "type": "command", "command": "$DEST", "padding": 0 },

  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "$DEST" } ] }
    ]
  }

See settings.example.json for the combined form.
EOF
