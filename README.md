# ⛽ context-gauge

A **context-saturation gauge for coding-agent harnesses** — [Claude Code](https://code.claude.com) and [Grok Build](https://docs.x.ai/build/cli). One small, dependency-free script that shows you — and tells the model — how full the session's *reasoning working set* is, so you split, scope down, or hand off **before** quality quietly degrades.

> Formerly `claude-context-gauge`. The binary is now `context-gauge`; `claude-context-gauge` remains a shim.

```
🟢 GREEN   <40K   full reasoning capacity
🟡 YELLOW  40–90K  prefer delegating searches; scope new inputs deliberately
🟠 ORANGE  90–150K split before reading; no new large reasoning input; checkpoint soon
🔴 RED     150–250K handoff imminent — finish what's in hand; take on no new load
⚫ BLACK    ≥250K   STOP — hand off now; the next big step risks lossy auto-compaction
```

**Bands are absolute working-set tokens**, not a % of the model window. The same table applies to Claude (~200K–1M) and Grok (grok-4.5 ≈ 500K, composer-fast ≈ 200K). A bigger window adds overflow room, not a longer effective span.

---

## Harness support

| Harness | Integration | Fill source | Floor |
|---------|-------------|-------------|-------|
| **Claude Code** | `statusLine` + `UserPromptSubmit` | transcript `usage` (`input + cache_read + cache_creation`) | first main assistant turn |
| **Grok Build** | `UserPromptSubmit` (+ `SessionStart` / `PostCompact` seed) | `signals.json` → `contextTokensUsed` | first observation (re-seed after compact) |

Auto-dispatch: stdin with `transcript_path` → Claude; `sessionId` / `GROK_SESSION_ID` → Grok.

---

## Why a *working set*, not raw fill

Every session is born tens of thousands of tokens deep — harness system prompt, tool schemas, always-injected files. That floor is cached, position-privileged, and **not** what the model actively reasons over. Banding *raw* fill would flag every fresh session as "degraded" on turn one (cry-wolf).

```
working = current_fill − session_floor
```

This self-calibrates per project so the band tracks the thing that actually degrades.

## Why *absolute tokens*, not % of the window

Long-context degradation onset is roughly **window-independent**:

- **NoLiMa** (2025): models advertised at 128K–1M drop below 50% of short-context baseline by **~32K** task tokens.
- **Chroma, "Context Rot"** (2025): a 200K-context model measurably degrades around **~50K**.
- **Lost in the Middle** (Liu et al., 2023): accuracy sags mid-context — a U-curve, not a cliff at the window edge.

The window size only feeds a secondary auto-compaction-proximity `%` (cosmetic).

> Thresholds are a considered default, not a law of nature. Tune the constants at the top of the script.

---

## Install

Requires **Python 3** (stdlib only — no third-party deps).

### One-liner (`uvx` / `pip`)

```sh
# run without installing
uvx --from git+https://github.com/jkubo/context-gauge context-gauge --self-test

# install as a user tool
uv tool install git+https://github.com/jkubo/context-gauge
# after PyPI publish:
# uvx context-gauge --self-test
# uv tool install context-gauge
# pipx install context-gauge
```

### From a clone

```sh
git clone https://github.com/jkubo/context-gauge
cd context-gauge
./install.sh          # → ~/.local/bin/context-gauge (+ claude-context-gauge shim)
# or: pip install -e .   /   uv tool install .
```
### Claude Code

Merge into `~/.claude/settings.json` (see [`settings.example.json`](settings.example.json)):

```json
{
  "statusLine": {
    "type": "command",
    "command": "$HOME/.local/bin/context-gauge",
    "padding": 0
  },
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "$HOME/.local/bin/context-gauge" } ] }
    ]
  }
}
```

`statusLine` needs a recent Claude Code (present as of **v2.1.212**). Use either or both integrations.

### Grok Build

Copy [`hooks.grok.example.json`](hooks.grok.example.json) to `~/.grok/hooks/context-gauge.json`, then `/hooks` → `r` (reload). Floor cache: `~/.context-gauge/floors/<session_id>.json`.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "$HOME/.local/bin/context-gauge", "timeout": 5 } ] }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "$HOME/.local/bin/context-gauge", "timeout": 5 } ] }
    ],
    "PostCompact": [
      { "hooks": [ { "type": "command", "command": "$HOME/.local/bin/context-gauge", "timeout": 5 } ] }
    ]
  }
}
```

Grok has no `statusLine` yet — inject-only.

---

## Configuration (optional env vars)

| Variable | Default | Effect |
|---|---|---|
| `CONTEXT_GAUGE_DISABLE` | *(unset)* | Any truthy value → no-op (kill switch). |
| `CLAUDE_CONTEXT_GAUGE_DISABLE` | *(unset)* | Legacy alias for the same. |
| `CONTEXT_GAUGE_WINDOW` | `200000` | Claude window for cosmetic `%` only. Set `1000000` for 1M beta. |
| `CLAUDE_CONTEXT_GAUGE_WINDOW` | — | Legacy alias. |
| `CONTEXT_GAUGE_FLOOR_DIR` | `~/.context-gauge/floors` | Grok floor cache directory. |
| `GROK_HOME` | `~/.grok` | Grok sessions root. |

---

## How it reads the numbers

**Claude.** Streams the session transcript JSONL for main-window assistant `usage` lines (skips sidechain/meta). Aborted turns that write all-zero usage are ignored (would otherwise false-GREEN a saturated session). Floor = fill of the first genuine assistant turn.

**Grok.** Resolves `~/.grok/sessions/<urlencode(cwd)>/<sessionId>/signals.json` and reads `contextTokensUsed` / `contextWindowTokens` / `compactionCount`. Floor is written on first observation and re-seeded when compaction runs or fill drops below the stored floor. Mid-session first attach seeds floor = current total (tracks growth from attach, under-alerts once rather than cry-wolf).

---

## CLI

```sh
context-gauge --self-test                 # print all five bands
context-gauge --transcript FILE.jsonl     # Claude: hook + status lines
context-gauge --session-dir DIR           # Grok: one reading from signals.json
context-gauge --signals FILE.json         # Grok: direct signals file
```

---

## Tests

```sh
python3 -m pytest tests/ -v
# or
python3 -m unittest tests.test_gauge -v
```

## Packaging / release

```sh
uv build                    # → dist/*.whl + dist/*.tar.gz
uv publish                  # needs UV_PUBLISH_TOKEN / PyPI trusted publisher
```

Entry points: `context-gauge` and `claude-context-gauge` (shim) → `context_gauge:main`.
---

## License

Apache-2.0. See [LICENSE](LICENSE).

---

## Rename note

This project was published as `claude-context-gauge` (2026-07-23). It grew a Grok Build backend and the neutral name **`context-gauge`**. The old binary name remains a shim; the GitHub repo redirects after rename.
