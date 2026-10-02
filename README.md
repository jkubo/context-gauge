# ⛽ context-gauge

A **context-saturation gauge for coding-agent harnesses**—[Claude Code](https://code.claude.com) and [Grok Build](https://docs.x.ai/build/cli). One small, dependency-free script that reports how full the session's *reasoning working set* is, as an absolute band.

> Formerly `claude-context-gauge`. The binary is now `context-gauge`; `claude-context-gauge` remains a shim.

```
🟢 GREEN   <40K    working set well inside the measured-reliable range
🟡 YELLOW  40–90K  working set moderate
🟠 ORANGE  90–150K working set large
🔴 RED     150–250K working set at the ~200K native-reliability boundary
⚫ BLACK    ≥250K   working set past the ~200K native-reliability boundary
```

## 🔴 The labels describe the number. They do not instruct the agent.

This is the one design rule the project has, and it was learned the hard way.

The band strings used to be imperatives—`STOP — hand off to a fresh session NOW`,
`finish only what's in hand`, `prefer delegating searches`, `checkpoint soon`—rendered into
the model's context as `reasoning: <imperative>` on **every single prompt**. An agent reading
that does not experience it as a gauge. It experiences it as an instruction sitting next to
the user's actual request, and it acts on it: truncating verification, narrowing scope,
proposing a handoff on an unfinished task, and reporting the colour back to an operator who
was already looking at it on their status bar.

One operator corrected that behaviour **six times** across five weeks. Five of those rounds
were answered by writing the prohibition into the agent's own rule files. It kept happening,
because a rule in a memory file cannot outrank a sentence that is regenerated into the context
window on every turn. The sixth round deleted the imperative at the source instead, which
worked immediately.

So: **a band label states what the number is. Never what the reader should do about it.**
`TestBandLabelsCarryNoImperative` fails the build on any verb aimed at the reader, and the
injected line closes by disclaiming itself as advisory telemetry for the operator.

If you are tempted to put the advice back because a descriptive label feels less useful—that
is the point. The gauge's job is to report a measurement to a human who can see it. Deciding
what to do about it is theirs.

> The degradation thresholds below are a considered default, not a measured cliff for any
> specific agent. Treat the boundary as a landmark, not a verdict.

**Bands are absolute working-set tokens**, not a % of the model window. The same table applies to Claude (~200K–1M) and Grok (grok-4.5 ≈ 500K, composer-fast ≈ 200K). A bigger window adds overflow room, not a longer effective span.

---

## Harness support

| Harness | Integration | Fill source | Floor |
|---------|-------------|-------------|-------|
| **Claude Code** (mod) | band above the prompt | the engine's own context figures | first response |
| **Claude Code** | `statusLine` + `UserPromptSubmit` | transcript `usage` (`input + cache_read + cache_creation`) | first main assistant turn |
| **Grok Build** | `UserPromptSubmit` (+ `SessionStart` / `PostCompact` seed) | `signals.json` → `contextTokensUsed` | first observation (re-seed after compact) |

Auto-dispatch: stdin with `transcript_path` → Claude; `sessionId` / `GROK_SESSION_ID` → Grok. The mod is not dispatched; Claude Code loads it as a plugin (see [Claude Code mod](#claude-code-mod)).

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

`statusLine` needs a recent Claude Code (present as of **v2.1.212**). Use either or both integrations. With the [Claude Code mod](#claude-code-mod) installed, both are optional for Claude.

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

## Claude Code mod

Claude Code **2.1.287** added mods: plugins of function hooks that can draw inside the
interface. This repository is one. Installed, it draws the fuel band directly above the prompt:

```
⛽ 🟠 ORANGE 140K · 20% of 1M ⚑ checkpoint · Opus 5
```

```
/plugin marketplace add jkubo/context-gauge
/plugin install context-gauge@context-gauge
```

- **Claude Code's own figures, no transcript scan.** The mod reads the live context window
  from the engine every 1.5 s and after each turn. Same bands, same thresholds, same flags as
  the statusLine: the band math is a port of `context_gauge.py`, and the Python suite fails
  if the two disagree on a constant or on any case in [`hooks/parity.ts`](hooks/parity.ts).
- **The floor** is the fill of the first response the mod sees in a session (the session's
  first, unless the mod arrived mid-session), kept for the session's life with compaction
  included, as the statusLine's transcript scan has it.
- **Nothing reaches the model.** The band is drawn for the operator only; the mod adds no
  prompt context and hooks no tool call.
- **Fitted thresholds** are read from `CONTEXT_GAUGE_THRESHOLDS`, else
  `~/.context-gauge/thresholds.json`, and validated as the CLI validates them.
  `CONTEXT_GAUGE_DISABLE` turns the band off.
- **Calibration samples** keep flowing when the CLI is installed at
  `~/.local/bin/context-gauge`: the mod hands each measurement to
  `context-gauge --record-sample`, which writes the row the live paths write
  (`CONTEXT_GAUGE_NO_SAMPLES` still opts out). Without the CLI the mod samples nothing.
- The **statusLine** and **UserPromptSubmit** wiring above stay supported; with the mod they
  are optional for Claude. **Grok is unchanged.**

Needs Claude Code **≥ 2.1.287**. Mods are early access, so the API under the band may change
between releases.

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
context-gauge --record-sample < R.json    # one calibration row (the mod's sampler)
```

---

## Tests

```sh
python3 -m pytest tests/ -v
# or
python3 -m unittest tests.test_gauge -v

# the Claude Code mod (Claude Code >= 2.1.287)
claude plugin validate . --strict
claude plugin test .
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
