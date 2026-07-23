# ⛽ claude-context-gauge

A **context-saturation gauge for [Claude Code](https://code.claude.com)**. One
small, dependency-free script that shows you — and tells the model — how full the
session's *reasoning working set* is, so you split, scope down, or hand off
**before** quality quietly degrades.

It runs as either (or both) of Claude Code's two integration points, dispatching
automatically on the input it receives:

- **statusLine** — an ANSI-colored band in your status bar:
  `⛽ 🟠 ORANGE 103K ⚑ handoff soon`
- **UserPromptSubmit hook** — injects a one-line `⛽ CONTEXT FUEL` reading into the
  model's context each turn, so *the model itself* can decide when to delegate or
  hand off (you can't *feel* saturation — the number doesn't lie).

```
🟢 GREEN   <40K   full reasoning capacity
🟡 YELLOW  40–90K  prefer delegating searches; scope new inputs deliberately
🟠 ORANGE  90–150K split before reading; no new large reasoning input; checkpoint soon
🔴 RED     150–250K handoff imminent — finish what's in hand; take on no new load
⚫ BLACK    ≥250K   STOP — hand off now; the next big step risks lossy auto-compaction
```

---

## Why a *working set*, not raw fill

Every Claude Code session is born tens of thousands of tokens deep — the harness
system prompt, tool schemas, and any always-injected files (`CLAUDE.md`, memory,
etc.). That floor is cached, position-privileged, and **not** what the model
actively reasons over. Banding *raw* fill would flag every fresh session as
"degraded" on turn one (cry-wolf).

So the gauge bands the **working set**:

```
working = current_fill − session_floor
```

where `session_floor` is the fill of the **first** assistant turn (the harness
floor) and `current_fill` is `input + cache_read + cache_creation` of the
**latest** assistant turn. This self-calibrates per project — a lean repo and a
heavy one land at comparable readings — so the band tracks the thing that
actually degrades.

## Why *absolute tokens*, not % of the window

Long-context degradation onset is roughly **window-independent**:

- **NoLiMa** (2025): models advertised at 128K–1M drop below 50% of their short-context
  baseline by **~32K** task tokens.
- **Chroma, "Context Rot"** (2025): a 200K-context model measurably degrades around **~50K**.
- **Lost in the Middle** (Liu et al., 2023): accuracy sags for information in the
  middle of a long context — a U-curve, not a cliff at the window edge.

A bigger window adds room to **overflow** the effective span, not to extend it. So
the band is **absolute working-set tokens**; the window size only feeds a
secondary auto-compaction-proximity `%` (cosmetic — the band does not depend on it).

> These thresholds are a considered default, not a law of nature. Tune the
> constants at the top of the script to your own taste and model.

---

## Install

Requires **Python 3** (standard library only — zero dependencies) and a recent
Claude Code with `statusLine` support (present as of **v2.1.212**; the docs don't
name an earlier introductory version — check `claude --version`).

```sh
git clone https://github.com/jkubo/claude-context-gauge
cd claude-context-gauge
./install.sh          # copies the script to ~/.local/bin and prints the settings snippet
```

Or by hand — copy `claude-context-gauge` somewhere on your `PATH`
(e.g. `~/.local/bin/`), `chmod +x` it, and wire it into `~/.claude/settings.json`.

### As a statusLine

```json
{
  "statusLine": {
    "type": "command",
    "command": "$HOME/.local/bin/claude-context-gauge",
    "padding": 0
  }
}
```

### As a UserPromptSubmit hook (optional — the injected `⛽ CONTEXT FUEL` line)

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "$HOME/.local/bin/claude-context-gauge" } ] }
    ]
  }
}
```

Use either or both. See [`settings.example.json`](settings.example.json) for a
combined example. (Replace `$HOME/...` with an absolute path if your shell doesn't
expand it.)

---

## Configuration (optional env vars)

| Variable | Default | Effect |
|---|---|---|
| `CLAUDE_CONTEXT_GAUGE_DISABLE` | *(unset)* | Any truthy value → no-op (kill switch). statusLine falls back to just the model name; the hook injects nothing. |
| `CLAUDE_CONTEXT_GAUGE_WINDOW` | `200000` | Context window in tokens, used only for the cosmetic `%` in the injected line. Set `1000000` if you run the 1M-context beta. |

---

## How it reads the numbers

Token usage comes from the session **transcript** (`transcript_path`, a JSONL
file), summing the `usage` object of assistant turns and skipping sub-agent
(sidechain) / meta lines. The scan is a single full-file streaming pass, so it
can't go blind when the newest `usage` line sits far behind a multi-megabyte tool
result.

> **Caveat (honest):** Claude Code's docs mark the transcript's on-disk format as
> *internal, and it can change between releases*. This tool reads only the
> long-stable `usage` token fields — but if a future release changes that shape,
> the gauge **fails open**: it shows a neutral `⛽ …` bar and injects nothing,
> never a wrong number and never a blocked prompt. If your bar goes neutral after
> an upgrade, [open an issue](https://github.com/jkubo/claude-context-gauge/issues).

**Fail-open is the whole safety model.** A `UserPromptSubmit` hook that exits
non-zero *erases the user's prompt*; a crashing statusLine wrecks the bar. Every
error path here returns exit 0 with an empty/neutral result.

---

## Test it

```sh
./claude-context-gauge --self-test              # print all five bands (bar + injected line)
./claude-context-gauge --transcript FILE.jsonl  # render both modes against a real transcript
python3 tests/test_gauge.py                      # the unit + black-box suite (stdlib unittest)
```

---

## License

[Apache-2.0](LICENSE).
