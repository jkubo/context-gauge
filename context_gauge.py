#!/usr/bin/env python3
"""context-gauge — a context-saturation gauge for coding-agent harnesses.

One self-contained, dependency-free script (Python 3 stdlib only) that bands
your **reasoning working set** (🟢→⚫) and reports it to the OPERATOR.

🔴 THE READING IS TELEMETRY, NOT A NUDGE, AND NOT A STOP RULE. This docstring used to end
"so you split / scope / hand off *before* quality quietly degrades", and the band strings
were written to match. That is the bug. These lines land in an agent's context window on
every prompt, where an imperative competes with the user's actual request — and wins often
enough to have drawn six corrections from this tool's own operator (2026-08-19, 08-21,
08-26, 08-27, 08-28, 09-21) for narrating the band, truncating work over it, or proposing a
handoff because a colour changed.

⚠️ The premise is also weaker than the old wording implied: measured on real transcripts,
tool-error rate is FLAT from GREEN through RED; only the user-correction rate rises, and it
rises most steeply at GREEN→YELLOW. The gauge is genuinely useful to a human deciding when to
start a fresh session. It is not evidence that the agent should stop mid-task.

Supported harnesses (auto-detected from stdin / env):

  • **Claude Code** — statusLine bar + UserPromptSubmit inject.
    Reads assistant ``usage`` from the session transcript.jsonl
    (input + cache_read + cache_creation). Floor = first main assistant turn.

  • **Grok Build** — UserPromptSubmit / SessionStart / PostCompact inject.
    Reads ``~/.grok/sessions/<cwd>/<id>/signals.json``
    (contextTokensUsed, contextWindowTokens). Floor self-calibrated per session
    and re-seeded after auto-compact.

WHAT IT MEASURES — WORKING SET, NOT RAW FILL:

    working = current_fill − session_floor

The floor is harness boilerplate (system prompt, tool schemas, always-injected
md) — cached, position-privileged, not what the model reasons over. Banding raw
fill cries wolf on turn 1.

TWO BANDS, AND THE COLOUR IS THE WORSE OF THEM:

  • ABSOLUTE working-set tokens — reasoning degradation. Onset is roughly
    window-independent (NoLiMa, Chroma "Context Rot", Lost-in-the-Middle); a
    bigger window adds overflow room, not a longer effective span. A 190K
    working set is degraded on a 1M window too, where a pure ratio reads 19%
    and says GREEN.
  • RATIO of the LIVE window consumed by total fill — proximity to the wall,
    i.e. lossy auto-compaction. The absolute band cannot see this on a small
    window, where 150K working is already the whole session.

Neither is honest on both a 200K and a 1M session, so the band is
``max(absolute, ratio)`` and the line names which one won.

THE DENOMINATOR IS READ, NOT ASSUMED. Claude Code reports
``context_window.context_window_size`` on every statusLine render; it moves
with the effective model and the 1M-context beta. Assuming 200K under-reports
a 1M session by 5x and fires the compaction warning at 16% full. When no
window is reported and none is cached, the ratio band is SKIPPED rather than
computed from a guess — an invented denominator must never manufacture a band.

CONFIG (optional env vars):
  CONTEXT_GAUGE_DISABLE          any truthy → no-op (kill switch)
  CLAUDE_CONTEXT_GAUGE_DISABLE   legacy alias for the same
  CONTEXT_GAUGE_WINDOW           pin the Claude window (else read from harness)
  CLAUDE_CONTEXT_GAUGE_WINDOW    legacy alias
  CONTEXT_GAUGE_FLOOR_DIR        Grok floor cache dir (default ~/.context-gauge/floors)
  CONTEXT_GAUGE_SAMPLES          sample log (default ~/.context-gauge/samples.jsonl)
  CONTEXT_GAUGE_NO_SAMPLES       any truthy → collect nothing
  CONTEXT_GAUGE_THRESHOLDS       fitted band ceilings (default ~/.context-gauge/thresholds.json)
  GROK_HOME                      override ~/.grok

FAIL-OPEN, ALWAYS. Any error / missing data / disable → emit nothing (hook) or a
minimal bar (statusLine) and exit 0. A UserPromptSubmit hook must NEVER exit
non-zero (exit 2 erases the user's prompt on Claude Code).

CLI:
  context-gauge --self-test
  context-gauge --calibrate [FILE.jsonl]         # both axes over collected samples
  context-gauge --transcript FILE.jsonl          # Claude
  context-gauge --session-dir DIR                # Grok
  context-gauge --signals FILE.json              # Grok
"""
from __future__ import annotations

import json
import os
import re
import stat
import sys
import time
from pathlib import Path
from urllib.parse import quote

# --- Band thresholds — ABSOLUTE WORKING-SET tokens (fill − floor) --------------
# Anchors: NoLiMa reasoning onset ~32K task tokens; a fresh coherent working set
# holds a little longer than NoLiMa's adversarial needle, so GREEN < 40K. RED
# 150–250K working ≈ the ~200K native-reliability boundary once a ~55–66K floor
# is added back. BLACK ≥ 250K: past that boundary; stop. Tune to taste.
GREEN_MAX = 40_000
YELLOW_MAX = 90_000
ORANGE_MAX = 150_000
RED_MAX = 250_000

# --- Band thresholds — RATIO of the LIVE window consumed by TOTAL fill --------
# This band is about hitting the wall (auto-compaction), not reasoning quality —
# the absolute band above owns that. Thresholds start loose deliberately: a
# session opens AT its floor, and a ~60-77K floor is already ~38% of a 200K
# window, so a tighter GREEN would paint turn 1 yellow. Compaction lands around
# 95%, which is where BLACK begins.
RATIO_GREEN_MAX = 0.50
RATIO_YELLOW_MAX = 0.70
RATIO_ORANGE_MAX = 0.85
RATIO_RED_MAX = 0.95
COMPACTION_WARN_RATIO = 0.80

DEFAULT_CLAUDE_WINDOW = 200_000
DEFAULT_GROK_WINDOW = 500_000
MAX_SCAN_BYTES = 64 * 1024 * 1024

# 🔴 DESCRIPTIVE LABELS ONLY — never imperatives aimed at the reading agent.
#
# These strings are injected into an agent's context window on every single prompt. A verb
# here is not a hint, it is an instruction competing with the user's actual request, and it
# wins often enough to have caused SIX corrections (2026-08-19, 08-21, 08-26, 08-27, 08-28,
# 09-21): agents narrating the band back to the operator, shortening or skipping work because
# of it, and proposing handoffs on a colour change mid-task.
#
# 🔑 Documentation did not fix it. A memory rule saying "the band is advisory" was loaded and
# injected during three of those violations; it lost to the imperative sitting in the same
# context window. The 08-28 round deleted the band tables out of the consuming skill files for
# this reason and missed the generator — so the sentence came back from here. The imperative
# does not get to exist.
#
# ⛔ Do not re-add "STOP", "hand off", "finish only", "prefer", "split", "checkpoint",
# "take on no new", or any other verb directed at the reader. Describe the NUMBER. The operator
# reads this gauge live and decides what it means.
BANDS = [
    (GREEN_MAX,  "GREEN",  "\U0001F7E2", "working set well inside the measured-reliable range"),
    (YELLOW_MAX, "YELLOW", "\U0001F7E1", "working set moderate"),
    (ORANGE_MAX, "ORANGE", "\U0001F7E0", "working set large"),
    (RED_MAX,    "RED",    "\U0001F534", "working set at the ~200K native-reliability boundary"),
    (float("inf"), "BLACK", "⚫", "working set past the ~200K native-reliability boundary"),
]

ABSOLUTE_CEILINGS = tuple(b[0] for b in BANDS)
RATIO_CEILINGS = (RATIO_GREEN_MAX, RATIO_YELLOW_MAX, RATIO_ORANGE_MAX,
                  RATIO_RED_MAX, float("inf"))

_ANSI = {"GREEN": "\033[32m", "YELLOW": "\033[33m",
         "ORANGE": "\033[38;5;208m", "RED": "\033[1;31m",
         "BLACK": "\033[1;97;41m"}
_RESET = "\033[0m"
_DIM = "\033[2m"
_SEP = f" {_DIM}·{_RESET} "


def _disabled() -> bool:
    return bool(
        os.environ.get("CONTEXT_GAUGE_DISABLE")
        or os.environ.get("CLAUDE_CONTEXT_GAUGE_DISABLE")
    )


def _positive_int(value):
    """int(value) if it is a usable token count, else None."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def window_from_payload(data) -> "int | None":
    """The window the harness itself reports, or None.

    Claude Code hands the statusLine a ``context_window`` object every render:
    ``{total_input_tokens, context_window_size, used_percentage, ...}``. That
    size is authoritative and dynamic — it follows the effective model, the
    1M-context beta, plan-mode model swaps and CLAUDE_CODE_MAX_CONTEXT_TOKENS.
    Read it; never infer it from the model name or the effort level.
    """
    if not isinstance(data, dict):
        return None
    cw = data.get("context_window")
    if isinstance(cw, dict):
        for key in ("context_window_size", "contextWindowSize"):
            n = _positive_int(cw.get(key))
            if n:
                return n
    else:
        n = _positive_int(cw)
        if n:
            return n
    for key in ("context_window_size", "contextWindowSize"):
        n = _positive_int(data.get(key))
        if n:
            return n
    return None


def resolve_claude_window(payload_window=None, session_id="") -> "tuple[int, bool]":
    """Return (window, known).

    Priority: explicit env pin > what the harness reported this call > what the
    harness reported earlier this session (cache) > DEFAULT_CLAUDE_WINDOW.

    ``known`` is False only for that last case. Callers must not band on an
    unknown window: guessing 200K on a 1M session inflates the ratio 5x, and a
    gauge that cries BLACK at 20% full gets ignored, which is the one failure
    mode a fuel gauge cannot afford.
    """
    pinned = _positive_int(
        os.environ.get("CONTEXT_GAUGE_WINDOW")
        or os.environ.get("CLAUDE_CONTEXT_GAUGE_WINDOW")
    )
    if pinned:
        return pinned, True
    reported = _positive_int(payload_window)
    if reported:
        return reported, True
    cached = load_window(session_id) if session_id else None
    if cached:
        return cached, True
    return DEFAULT_CLAUDE_WINDOW, False


# Session ids are attacker-adjacent: they name a cache file and a session dir.
# Allowlist, never blocklist — anything outside this charset is refused outright
# rather than sanitized, so no traversal (`..`, `/`, NUL) can reach a path join.
_SAFE_SESSION_ID = re.compile(r"\A[A-Za-z0-9._-]{1,128}\Z")


def safe_session_id(session_id) -> str:
    """Return the id if it is safe to use as a path component, else ""."""
    sid = str(session_id or "")
    if sid in (".", "..") or not _SAFE_SESSION_ID.match(sid):
        return ""
    return sid


# The model name comes out of signals.json and is rendered straight into the
# text injected into the model's context every turn. Treat it as untrusted:
# a newline or bracket there could forge structure in the injected line.
_SAFE_MODEL = re.compile(r"[^A-Za-z0-9._:/ -]")


def safe_model(model) -> str:
    """Model id reduced to a harmless charset, length-capped."""
    return _SAFE_MODEL.sub("", str(model or "")).strip()[:64]


def _env_path(*names, default=""):
    """First non-empty env var among names, ~-expanded. Empty string ≠ set."""
    for name in names:
        val = os.environ.get(name)
        if val:
            return os.path.expanduser(val)
    return os.path.expanduser(default)


def _floor_dir() -> Path:
    return Path(_env_path(
        "CONTEXT_GAUGE_FLOOR_DIR",
        "GAIUS_GROK_FLOOR_DIR",  # kub0/gaius compat
        default="~/.context-gauge/floors",
    ))


def _grok_home() -> Path:
    return Path(_env_path("GROK_HOME", default="~/.grok"))


def _samples_path() -> Path:
    custom = _env_path("CONTEXT_GAUGE_SAMPLES", default="")
    return Path(custom) if custom else _floor_dir().parent / "samples.jsonl"


def _fmt_k(n) -> str:
    n = float(n)
    return f"{n/1000:.0f}K" if n < 1_000_000 else f"{n/1_000_000:.2f}M"


def _fmt_window(n) -> str:
    """Windows are round numbers — "1M" reads better than "1.00M"."""
    s = _fmt_k(n)
    return s[:-1].rstrip("0").rstrip(".") + "M" if s.endswith("M") else s


def _band_index(value, ceilings) -> int:
    for i, ceiling in enumerate(ceilings):
        if value < ceiling:
            return i
    return len(ceilings) - 1


# ── Fitted thresholds (the closed loop) ───────────────────────────────────────
# `gaius degradation calibrate --apply` measures where degradation events
# actually cluster and publishes ceilings here. This is the READ side. Memoized
# per process — each render is a fresh process, so one small read, never a
# re-stat storm. Absent/corrupt/incomplete file → compiled defaults, silently:
# a broken tuning file must degrade to the shipped guess, not to no gauge.
_TUNED = None
_TUNE_KEYS = ("green_max", "yellow_max", "orange_max", "red_max")


def _thresholds_path() -> Path:
    custom = _env_path("CONTEXT_GAUGE_THRESHOLDS", default="")
    return Path(custom) if custom else _floor_dir().parent / "thresholds.json"


def _tuned() -> dict:
    global _TUNED
    if _TUNED is not None:
        return _TUNED
    _TUNED = {}
    try:
        blob = json.loads(_thresholds_path().read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return _TUNED
    if not isinstance(blob, dict):
        return _TUNED
    for axis in ("working", "ratio"):
        spec = blob.get(axis)
        if not isinstance(spec, dict):
            continue
        vals = [spec.get(k) for k in _TUNE_KEYS]
        try:
            vals = [float(v) for v in vals]
        except (TypeError, ValueError):
            continue
        # Monotonic and positive, or it is not a band table.
        if all(v > 0 for v in vals) and all(a < b for a, b in zip(vals, vals[1:])):
            _TUNED[axis] = tuple(vals) + (float("inf"),)
    return _TUNED


def active_ceilings():
    """(absolute, ratio) ceilings in force — fitted if published, else defaults."""
    t = _tuned()
    return (t.get("working", ABSOLUTE_CEILINGS), t.get("ratio", RATIO_CEILINGS))


def band_for(working):
    """Absolute working-set band. Kept as-is — external callers import this."""
    _c, name, emoji, action = BANDS[_band_index(working, active_ceilings()[0])]
    return name, emoji, action


def resolve_band(working, total=None, window=None):
    """Band = the WORSE of the working-set band and the window-ratio band.

    Returns ``(name, emoji, action, source, frac)``. ``frac`` is the share of
    the window consumed, or None when ``window`` is None (unknown) — in which
    case the ratio band is skipped entirely and the absolute band stands alone,
    which is the pre-dynamic-window behaviour.
    """
    abs_ceilings, ratio_ceilings = active_ceilings()
    idx_abs = _band_index(working, abs_ceilings)
    frac = None
    idx_ratio = None
    if window and total is not None and total > 0:
        frac = total / float(window)
        idx_ratio = _band_index(frac, ratio_ceilings)

    if idx_ratio is None or idx_abs == idx_ratio:
        idx, source = idx_abs, "working set" if idx_ratio is None else "both"
    elif idx_ratio > idx_abs:
        idx, source = idx_ratio, "window ratio"
    else:
        idx, source = idx_abs, "working set"

    _c, name, emoji, action = BANDS[idx]
    return name, emoji, action, source, frac


# ── Claude: transcript usage ──────────────────────────────────────────────────

def compute_fill(usage) -> int:
    """Context fill = everything the model reads on input; output tokens excluded."""
    return (
        int(usage.get("input_tokens", 0) or 0)
        + int(usage.get("cache_read_input_tokens", 0) or 0)
        + int(usage.get("cache_creation_input_tokens", 0) or 0)
    )


def _is_main_assistant_usage(obj):
    if obj.get("isSidechain") or obj.get("isMeta"):
        return None
    msg = obj.get("message") or {}
    usage = msg.get("usage")
    if usage and (msg.get("role") == "assistant" or obj.get("type") == "assistant"):
        # ABORTED-TURN GUARD: all-zero usage is a stub, not a zero fill.
        # Trusting it → false GREEN exactly when the session is most saturated.
        if compute_fill(usage) > 0:
            return usage
        return None
    return None


def scan_usage(transcript_path):
    """Scan a Claude transcript for first/last main-assistant usage.

    Fail-open on anything that is not a regular file: a character device
    (``/dev/zero``), FIFO, or socket can hang forever on a blocking read.
    ``getsize`` alone is not enough — those report size 0.
    """
    try:
        st = os.stat(transcript_path)
    except OSError:
        return None, None
    if not stat.S_ISREG(st.st_mode):
        return None, None
    size = st.st_size

    first = last = None
    try:
        if size <= MAX_SCAN_BYTES:
            with open(transcript_path, "rb") as f:
                for raw in f:
                    if b'"usage"' not in raw:
                        continue
                    try:
                        obj = json.loads(raw)
                    except (ValueError, UnicodeDecodeError):
                        continue
                    u = _is_main_assistant_usage(obj)
                    if u is not None:
                        if first is None:
                            first = u
                        last = u
        else:
            with open(transcript_path, "rb") as f:
                head = f.read(1_000_000)
                f.seek(size - 4_000_000)
                f.readline()
                tail = f.read()
            for raw in head.splitlines():
                if b'"usage"' in raw:
                    try:
                        u = _is_main_assistant_usage(json.loads(raw))
                    except (ValueError, UnicodeDecodeError):
                        u = None
                    if u is not None:
                        first = u
                        break
            for raw in reversed(tail.splitlines()):
                if b'"usage"' in raw:
                    try:
                        u = _is_main_assistant_usage(json.loads(raw))
                    except (ValueError, UnicodeDecodeError):
                        u = None
                    if u is not None:
                        last = u
                        break
    except (OSError, ValueError):
        return None, None
    return first, last


def reading_claude(transcript_path, window=None, session_id=""):
    """Return (working, total, floor, window, model) or None.

    ``window`` in is whatever this call's payload reported (or None); ``window``
    out is the resolved size, or **None when it is only a guess** — that is the
    signal downstream not to compute a ratio band from it.
    """
    first, last = scan_usage(transcript_path)
    if last is None:
        return None
    total = compute_fill(last)
    floor = compute_fill(first) if first is not None else 0
    working = max(0, total - floor)
    resolved, known = resolve_claude_window(window, session_id)
    return working, total, floor, (resolved if known else None), ""


# Back-compat: pre-rename consumers import this module and call reading().
# gaius/marathon.py is one such caller. Keep the alias so the unified module is
# a drop-in for anything still on the old name.
reading = reading_claude


# ── Grok: signals.json ────────────────────────────────────────────────────────

def session_dir_for(session_id: str, workspace: str | None):
    session_id = safe_session_id(session_id)
    if not session_id:
        return None
    sessions = _grok_home() / "sessions"
    if workspace:
        enc = quote(os.path.abspath(workspace), safe="")
        candidate = sessions / enc / session_id
        if candidate.is_dir():
            return candidate
    try:
        for child in sessions.iterdir():
            if child.is_dir() and (child / session_id).is_dir():
                return child / session_id
    except OSError:
        return None
    return None


def load_signals(session_dir: Path):
    p = session_dir / "signals.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def _floor_path(session_id: str):
    """Cache path for a session floor, or None if the id is not path-safe."""
    sid = safe_session_id(session_id)
    if not sid:
        return None
    return _floor_dir() / f"{sid}.json"


def load_floor(session_id: str):
    path = _floor_path(session_id)
    if path is None:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def _secure_write_json(path: Path, obj: dict):
    """Write JSON to a cache file, privately, never through a symlink."""
    payload = json.dumps(obj, indent=2) + "\n"
    try:
        d = path.parent
        # 0o700 survives any umask (umask only clears bits), so a dir we create
        # is private by construction. An older 0755 dir is tightened in place.
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(d, 0o700)
        except OSError:
            pass
        # Create with 0o600 up front — an open()-then-chmod() leaves the file
        # world-readable for the width of the write.
        # O_NOFOLLOW: never write through a symlink planted in the cache dir —
        # and never chmod its target. Falls back to a plain refusal, not a write.
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(str(path), flags, 0o600)
        try:
            os.write(fd, payload.encode("utf-8"))
            try:
                os.fchmod(fd, 0o600)  # normalize files left 0644 by older versions
            except OSError:
                pass
        finally:
            os.close(fd)
    except OSError:
        pass


def save_floor(session_id: str, floor: int, window: int, model: str, compaction_count: int):
    path = _floor_path(session_id)
    if path is None:
        return
    _secure_write_json(path, {
        "floor": int(floor),
        "window": int(window),
        "model": model or "",
        "compaction_count": int(compaction_count or 0),
        "seeded_at": time.time(),
    })


# ── Claude: remembered window ─────────────────────────────────────────────────
# Only the statusLine payload is documented to carry context_window, but the
# hook surfaces need the same denominator. The statusLine renders constantly,
# so it seeds this cache and the hook reads it. Same dir, same allowlisted id,
# same 0700/0600 write — a distinct suffix so it cannot collide with a floor.

def _window_cache_path(session_id: str):
    sid = safe_session_id(session_id)
    if not sid:
        return None
    return _floor_dir() / f"{sid}.window.json"


def load_window(session_id: str):
    path = _window_cache_path(session_id)
    if path is None:
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return _positive_int(payload.get("window")) if isinstance(payload, dict) else None


SAMPLES_MAX_BYTES = 8 * 1024 * 1024


def _sample_state_path(session_id: str):
    sid = safe_session_id(session_id)
    return (_floor_dir() / f"{sid}.sample.json") if sid else None


def record_sample(session_id, harness, working, total, floor, window,
                  model="", effort=""):
    """Append one RAW observation per turn, so thresholds can be MEASURED.

    Numbers only — never a band. Persisting GREEN/ORANGE/... would freeze
    today's guess into history and make recalibration circular; storing raw
    fuel means changing a threshold re-buckets every sample ever taken. (Same
    contract as gaius.degradation's turn_fuel, which is why this records the
    one column that table structurally cannot: ``window``. A Claude transcript
    carries ``usage`` but never the window, so only this surface — handed
    ``context_window`` by the harness on every render — can witness it.)

    BOTH axes land in one row: ``working`` for the reasoning axis, and
    ``total``+``window`` for the saturation ratio. Deduped on ``total``,
    because the statusLine re-renders many times per turn while the fill only
    moves when the model actually spends context.

    Content-free: token counts, a session id, model and effort. No prompt or
    tool text ever reaches this file.
    """
    if os.environ.get("CONTEXT_GAUGE_NO_SAMPLES"):
        return
    sid = safe_session_id(session_id)
    state = _sample_state_path(sid)
    total = _positive_int(total)
    if not sid or state is None or total is None:
        return
    try:
        prev = json.loads(state.read_text(encoding="utf-8")).get("last_total")
    except (OSError, ValueError, UnicodeDecodeError, AttributeError):
        prev = None
    if prev == total:
        return
    row = {
        "ts": round(time.time(), 3),
        "session": sid,
        "harness": harness,
        "working": int(working or 0),
        "total": total,
        "floor": int(floor or 0),
        "window": _positive_int(window),
        "model": safe_model(model),
        "effort": safe_model(effort),
    }
    try:
        path = _samples_path()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # One generation of rotation: a gauge must never fill a disk.
        if path.exists() and path.stat().st_size > SAMPLES_MAX_BYTES:
            path.replace(path.with_suffix(".1.jsonl"))
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(str(path), flags, 0o600)
        try:
            os.write(fd, (json.dumps(row) + "\n").encode("utf-8"))
        finally:
            os.close(fd)
    except (OSError, ValueError):
        return  # fail-open: a sampler must never break the gauge
    _secure_write_json(state, {"last_total": total})


def save_window(session_id: str, window):
    """Remember a harness-reported window. No-op unless it changed.

    This runs on every statusLine render — rewriting an identical file a few
    times a second is pure churn.
    """
    window = _positive_int(window)
    path = _window_cache_path(session_id)
    if path is None or window is None or load_window(session_id) == window:
        return
    _secure_write_json(path, {"window": window, "seeded_at": time.time()})


def resolve_floor(session_id: str, total: int, window: int, model: str, compaction_count: int) -> int:
    if total <= 0:
        return 0
    prev = load_floor(session_id)
    if prev is None:
        save_floor(session_id, total, window, model, compaction_count)
        return total
    floor = int(prev.get("floor") or 0)
    prev_cc = int(prev.get("compaction_count") or 0)
    if compaction_count > prev_cc or (floor > 0 and total < floor):
        save_floor(session_id, total, window, model, compaction_count)
        return total
    if prev.get("window") != window or prev.get("model") != model:
        save_floor(session_id, floor, window, model, compaction_count)
    return floor


def reading_grok_signals(sig: dict, session_id: str):
    """Return (working, total, floor, window, model) or None."""
    total = int(sig.get("contextTokensUsed") or 0)
    if total <= 0:
        return None
    # Grok reports its own window in signals.json. Only when it does not is the
    # default a guess — and a guess must not reach the ratio band.
    reported = _positive_int(sig.get("contextWindowTokens"))
    window = reported or DEFAULT_GROK_WINDOW
    models = sig.get("modelsUsed") or []
    model = safe_model(sig.get("primaryModelId") or (models[0] if models else ""))
    cc = int(sig.get("compactionCount") or 0)
    floor = resolve_floor(session_id, total, window, model, cc)
    working = max(0, total - floor)
    return working, total, floor, reported, model


def reading_grok(session_id: str, workspace: str | None = None):
    sd = session_dir_for(session_id, workspace)
    if sd is None:
        return None
    sig = load_signals(sd)
    if not sig:
        return None
    return reading_grok_signals(sig, session_id)


# ── shared render ─────────────────────────────────────────────────────────────

def gauge_line(working, total, floor, window=None, model=""):
    name, emoji, action, source, frac = resolve_band(working, total, window)
    if frac is None:
        # Say so out loud. A denominator presented without a caveat gets read as
        # measured, and this one is a fallback constant.
        shown, _known = resolve_claude_window(window)
        window_bit = f"· window {_fmt_window(shown)}? (assumed — none reported) "
        compaction = ""
    else:
        window_bit = f"· {frac*100:.0f}% of {_fmt_window(window)} window "
        compaction = "· compaction near ⚠ " if frac >= COMPACTION_WARN_RATIO else ""
    model_bit = f"· model {model} " if model else ""
    # Print the ceilings ACTUALLY in force. A legend showing the shipped
    # defaults while a fit is live would misreport the gauge to itself.
    a, r = active_ceilings()
    tuned_bit = " (fitted)" if _tuned() else ""
    return (
        f"⛽ CONTEXT FUEL {_fmt_k(working)} working set ({emoji} {name}) "
        f"[{_fmt_k(total)} total − {_fmt_k(floor)} floor] "
        f"{window_bit}{compaction}{model_bit}"
        f"· band set by: {source} "
        f"· {action}. "
        f"[working set: \U0001F7E2<{_fmt_k(a[0])} \U0001F7E1<{_fmt_k(a[1])} "
        f"\U0001F7E0<{_fmt_k(a[2])} \U0001F534<{_fmt_k(a[3])} ⚫≥{_fmt_k(a[3])} "
        f"· window: \U0001F7E2<{r[0]:.0%} \U0001F7E1<{r[1]:.0%} "
        f"\U0001F7E0<{r[2]:.0%} \U0001F534<{r[3]:.0%} ⚫≥{r[3]:.0%}{tuned_bit} "
        f"· colour = the worse of the two] "
        # 🔴 The old line closed with "reasoning: <imperative>" — it labelled the band as a
        # verdict on the reader's own reasoning and then told them what to do about it. That
        # framing caused six violations. State the reading, then disclaim it explicitly, so a
        # model scanning its context finds nothing here to obey.
        f"— ADVISORY TELEMETRY FOR THE OPERATOR, who watches this live. Not a stop rule, not a "
        f"loop control, not a reason to hand off, wrap up, shorten, skip a step, or narrow "
        f"scope. Do not mention it to the user."
    )


def load_samples(path=None):
    """Every recorded observation. Corrupt lines are skipped, not fatal."""
    p = Path(path) if path else _samples_path()
    rows = []
    try:
        with open(p, "rb") as f:
            for raw in f:
                try:
                    obj = json.loads(raw)
                except (ValueError, UnicodeDecodeError):
                    continue
                if isinstance(obj, dict) and obj.get("total"):
                    rows.append(obj)
    except OSError:
        return []
    return rows


def _pct(sorted_vals, p):
    if not sorted_vals:
        return 0
    k = (len(sorted_vals) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def calibrate(path=None):
    """Both axes, side by side, so the thresholds can be argued from data.

    This is DESCRIPTIVE only: where sessions actually sit. It tells you whether
    a threshold is reachable and how much of your life it colours — not whether
    crossing it hurts. That needs an outcome signal (gaius.degradation's tool
    errors / thrash / reverts, joined on session+window), and it needs samples
    to accumulate first. Reading a curve off three sessions is how you get a
    confident wrong answer.
    """
    rows = load_samples(path)
    out = [f"samples: {len(rows)}"]
    if not rows:
        out.append("(nothing collected yet — the gauge records one row per turn as you work)")
        return "\n".join(out)

    sessions = {r.get("session") for r in rows}
    windows = {}
    for r in rows:
        windows[r.get("window")] = windows.get(r.get("window"), 0) + 1
    out.append(f"sessions: {len(sessions)}")
    out.append("windows seen: " + ", ".join(
        f"{_fmt_window(w) if w else 'unreported'}×{n}"
        for w, n in sorted(windows.items(), key=lambda kv: -kv[1])))

    working = sorted(int(r.get("working") or 0) for r in rows)
    ratios = sorted(r["total"] / r["window"] for r in rows if r.get("window"))

    out.append("")
    out.append("WORKING SET (reasoning axis)          p50      p75      p90      p95      p99      max")
    out.append("  tokens                        " + "".join(
        f"{_fmt_k(_pct(working, p)):>9}" for p in (.5, .75, .9, .95, .99, 1.0)))
    if ratios:
        out.append("WINDOW SATURATION (space axis)        p50      p75      p90      p95      p99      max")
        out.append("  % of window                   " + "".join(
            f"{_pct(ratios, p)*100:>8.0f}%" for p in (.5, .75, .9, .95, .99, 1.0)))
    else:
        out.append("WINDOW SATURATION: no sample carried a reported window yet.")

    def _share(vals, ceilings):
        counts = [0] * len(BANDS)
        for v in vals:
            counts[_band_index(v, ceilings)] += 1
        return counts

    abs_ceilings, ratio_ceilings = active_ceilings()
    out.append("")
    out.append("thresholds in force: " + ("FITTED from measured rot "
               "(gaius degradation calibrate)" if _tuned() else "shipped defaults — "
               "run `gaius degradation calibrate` to fit them from your own data"))
    out.append("time spent per band under those thresholds (change them and re-run — no band is stored):")
    names = [b[1] for b in BANDS]
    wshare = _share(working, abs_ceilings)
    out.append("  working set : " + "  ".join(
        f"{n} {c*100//max(1, len(working))}%" for n, c in zip(names, wshare)))
    if ratios:
        rshare = _share(ratios, ratio_ceilings)
        out.append("  saturation  : " + "  ".join(
            f"{n} {c*100//max(1, len(ratios))}%" for n, c in zip(names, rshare)))
    return "\n".join(out)


def _safe_write(text: str, trailing_newline: bool = True) -> None:
    """Write to stdout without raising on encoding failure.

    Under ``PYTHONIOENCODING=ascii`` (or any narrow locale), emoji and other
    non-ASCII in the statusLine / hook payload would otherwise raise
    ``UnicodeEncodeError`` and the outer fail-open catch would swallow it into
    a silent blank line. Prefer the stream's own encoding with replacement so
    the band name and model still render; fall back to the binary buffer.
    """
    out = text
    if trailing_newline and not out.endswith("\n"):
        out = out + "\n"
    try:
        sys.stdout.write(out)
        try:
            sys.stdout.flush()
        except Exception:
            pass
        return
    except UnicodeEncodeError:
        pass
    enc = getattr(sys.stdout, "encoding", None) or "ascii"
    data = out.encode(enc, errors="replace")
    buf = getattr(sys.stdout, "buffer", None)
    if buf is not None:
        try:
            buf.write(data)
            buf.flush()
            return
        except Exception:
            pass
    try:
        sys.stdout.write(out.encode("ascii", errors="replace").decode("ascii"))
        sys.stdout.flush()
    except Exception:
        pass


def emit_hook(text: str, event: str = "UserPromptSubmit"):
    # Echo the event we were actually invoked for — a SessionStart inject that
    # claims to be UserPromptSubmit can be dropped or misrouted by the harness.
    # ensure_ascii=False keeps real emoji for UTF-8 consumers; _safe_write
    # degrades under ascii locales instead of blanking the hook.
    payload = json.dumps({
        "hookSpecificOutput": {
            "hookEventName": event or "UserPromptSubmit",
            "additionalContext": text,
        }
    }, ensure_ascii=False)
    _safe_write(payload)


def band_flag(name, source):
    """The bar flag names the REMEDY — and the remedy differs by axis.

    A bloated working set and a full window both end a session, but not the
    same way: one reasons worse, the other gets auto-compacted out from under
    you. Flagging both "handoff soon" was only ever right because on a 200K
    window they arrived together (118K working + a 77K floor IS 97% of 200K).
    An honest denominator pulled them apart, and the flag was left asserting
    the space axis while the band's own advice said "checkpoint soon".
    """
    if name == "BLACK":
        return "⚑ HANDOFF NOW"
    by_window = source in ("window ratio", "both")
    if name == "RED":
        return "⚑ compaction imminent" if by_window else "⚑ handoff soon"
    if name == "ORANGE":
        return "⚑ compaction near" if by_window else "⚑ checkpoint"
    return ""


def band_segment(working, total=None, window=None):
    name, emoji, _action, source, frac = resolve_band(working, total, window)
    color = _ANSI.get(name, "")
    seg = f"{color}⛽ {emoji} {name} {_fmt_k(working)}{_RESET}"
    if frac is not None:
        # The denominator earns its place on the bar: it is the number that
        # silently changed under you when the model or the beta changed.
        seg += f"{_SEP}{color}{frac*100:.0f}% of {_fmt_window(window)}{_RESET}"
    flag = band_flag(name, source)
    if flag:
        seg += f" {color}{flag}{_RESET}"
    return seg


def statusline_claude(transcript_path, model="", window=None, session_id="", effort=""):
    tail = model or ""
    if _disabled():
        return tail
    suffix = (_SEP + tail) if tail else ""
    r = reading_claude(transcript_path, window, session_id) if transcript_path else None
    if r is None:
        return f"{_DIM}⛽ …{_RESET}{suffix}"
    working, total, floor, win, _m = r
    # Sample only from a live session. `--transcript` inspection of someone
    # else's log must not enter the calibration corpus.
    if session_id:
        record_sample(session_id, "claude", working, total, floor, win, model, effort)
    return band_segment(working, total, win) + suffix


# ── dispatch ──────────────────────────────────────────────────────────────────

# Claude sends CamelCase event names; Grok sends snake_case. Match both, and
# canonicalize so the echoed hookEventName is always harness-legal.
_EVENT_ALIASES = {
    "userpromptsubmit": "UserPromptSubmit",
    "user_prompt_submit": "UserPromptSubmit",
    "sessionstart": "SessionStart",
    "session_start": "SessionStart",
    "postcompact": "PostCompact",
    "post_compact": "PostCompact",
}


def _event_name(data: dict) -> str:
    """Canonical hook event name, or "" if this payload is not a hook event."""
    raw = (
        data.get("hook_event_name")
        or data.get("hookEventName")
        or data.get("event")
        or ""
    )
    return _EVENT_ALIASES.get(str(raw).strip().lower(), "")


def _is_hook_event(data: dict) -> bool:
    return bool(_event_name(data))


def _looks_like_grok(data: dict) -> bool:
    """A Grok envelope never carries a Claude transcript path.

    Claude sends session_id on BOTH its hook and its statusLine payload, so
    keying on session_id alone routes every statusLine render down the hook
    path and prints raw JSON into the status bar. transcript_path is the
    reliable discriminator; check it first.
    """
    if data.get("transcript_path") or data.get("transcriptPath"):
        return False
    if data.get("sessionId") or data.get("session_id"):
        return True
    if data.get("workspaceRoot") or data.get("workspace_root"):
        return True
    return bool(os.environ.get("GROK_SESSION_ID"))


def main() -> int:
    args = sys.argv[1:]

    if "--self-test" in args:
        floor = 60_000
        # Same working sets, two windows: the divergence IS the feature.
        for window in (200_000, 1_000_000):
            print(f"── window {_fmt_window(window)} " + "─" * 46)
            for working in (10_000, 60_000, 120_000, 200_000, 300_000):
                total = working + floor
                print(f"bar   : {band_segment(working, total, window)}")
                print(f"inject: {gauge_line(working, total, floor, window=window, model='opus-5')}")
                print()
        print("── window unreported: ratio skipped, absolute stands alone " + "─" * 6)
        for working in (10_000, 200_000):
            print(f"bar   : {band_segment(working, working + floor, None)}")
        return 0

    if "--calibrate" in args:
        i = args.index("--calibrate") + 1
        path = args[i] if i < len(args) and not args[i].startswith("-") else None
        print(calibrate(path))
        return 0

    if "--transcript" in args:
        i = args.index("--transcript") + 1
        if i >= len(args):
            print("usage: --transcript <file.jsonl>", file=sys.stderr)
            return 0
        r = reading_claude(args[i])
        if r is None:
            print("(no assistant usage found)", file=sys.stderr)
            return 0
        print("hook  :", gauge_line(*r))
        print("status:", statusline_claude(args[i], model="claude"))
        return 0

    if "--session-dir" in args:
        i = args.index("--session-dir") + 1
        if i >= len(args):
            print("usage: --session-dir <path>", file=sys.stderr)
            return 0
        sd = Path(args[i])
        sig = load_signals(sd)
        if not sig:
            print("(no signals.json)", file=sys.stderr)
            return 0
        r = reading_grok_signals(sig, sd.name)
        if r is None:
            print("(no contextTokensUsed yet)", file=sys.stderr)
            return 0
        print(gauge_line(*r))
        return 0

    if "--signals" in args:
        i = args.index("--signals") + 1
        if i >= len(args):
            print("usage: --signals <signals.json>", file=sys.stderr)
            return 0
        p = Path(args[i])
        try:
            sig = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            print("(unreadable signals)", file=sys.stderr)
            return 0
        r = reading_grok_signals(sig, p.parent.name)
        if r is None:
            print("(no contextTokensUsed yet)", file=sys.stderr)
            return 0
        print(gauge_line(*r))
        return 0

    # --- live path ---
    try:
        data = json.load(sys.stdin)
    except Exception:
        print("")
        return 0

    event = _event_name(data)
    is_hook = bool(event)
    is_grok = _looks_like_grok(data)
    tp = data.get("transcript_path") or data.get("transcriptPath") or ""
    claude_sid = safe_session_id(data.get("session_id") or data.get("sessionId") or "")
    payload_window = window_from_payload(data)
    model_name = (data.get("model") or {}).get("display_name", "") if isinstance(data.get("model"), dict) else ""
    effort = (data.get("effort") or {}).get("level", "") if isinstance(data.get("effort"), dict) else ""
    # Seed the cache from whichever surface was handed a window, so the surface
    # that was not still bands against the real one.
    if claude_sid and payload_window:
        save_window(claude_sid, payload_window)

    if is_hook or is_grok:
        try:
            if _disabled():
                return 0
            r = None
            sid = ""
            if is_grok or not tp:
                sid = (
                    data.get("sessionId")
                    or data.get("session_id")
                    or os.environ.get("GROK_SESSION_ID")
                    or ""
                )
                workspace = (
                    data.get("workspaceRoot")
                    or data.get("workspace_root")
                    or data.get("cwd")
                    or os.environ.get("GROK_WORKSPACE_ROOT")
                    or os.environ.get("CLAUDE_PROJECT_DIR")
                    or ""
                )
                if sid:
                    r = reading_grok(sid, workspace or None)
            harness = "grok"
            if r is None and tp:
                r = reading_claude(tp, payload_window, claude_sid)
                harness, sid = "claude", claude_sid
            if r is None:
                return 0
            record_sample(sid, harness, r[0], r[1], r[2], r[3], r[4] or model_name, effort)
            emit_hook(gauge_line(*r), event)
        except Exception:
            pass
        return 0

    # Claude statusLine mode (stdin is statusLine payload, not a hook)
    try:
        _safe_write(statusline_claude(tp, model_name, payload_window, claude_sid, effort))
    except Exception:
        _safe_write("")
    return 0


if __name__ == "__main__":
    sys.exit(main())
