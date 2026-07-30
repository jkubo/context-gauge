#!/usr/bin/env python3
"""context-gauge — a context-saturation gauge for coding-agent harnesses.

One self-contained, dependency-free script (Python 3 stdlib only) that bands
your **reasoning working set** (🟢→⚫) so you split / scope / hand off *before*
quality quietly degrades.

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

WHY ABSOLUTE TOKENS, NOT % OF WINDOW. Degradation onset is roughly
window-independent (NoLiMa, Chroma "Context Rot", Lost-in-the-Middle). A bigger
window adds overflow room, not a longer effective span. The band is absolute
working-set tokens; the window only feeds a cosmetic compaction-proximity %.

CONFIG (optional env vars):
  CONTEXT_GAUGE_DISABLE          any truthy → no-op (kill switch)
  CLAUDE_CONTEXT_GAUGE_DISABLE   legacy alias for the same
  CONTEXT_GAUGE_WINDOW           override window for Claude % (default 200000)
  CLAUDE_CONTEXT_GAUGE_WINDOW    legacy alias
  CONTEXT_GAUGE_FLOOR_DIR        Grok floor cache dir (default ~/.context-gauge/floors)
  GROK_HOME                      override ~/.grok

FAIL-OPEN, ALWAYS. Any error / missing data / disable → emit nothing (hook) or a
minimal bar (statusLine) and exit 0. A UserPromptSubmit hook must NEVER exit
non-zero (exit 2 erases the user's prompt on Claude Code).

CLI:
  context-gauge --self-test
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

DEFAULT_CLAUDE_WINDOW = 200_000
DEFAULT_GROK_WINDOW = 500_000
MAX_SCAN_BYTES = 64 * 1024 * 1024

BANDS = [
    (GREEN_MAX,  "GREEN",  "\U0001F7E2", "full reasoning capacity"),
    (YELLOW_MAX, "YELLOW", "\U0001F7E1", "prefer delegating searches; scope new inputs deliberately"),
    (ORANGE_MAX, "ORANGE", "\U0001F7E0", "split before reading; take on no new large reasoning input; checkpoint soon"),
    (RED_MAX,    "RED",    "\U0001F534", "handoff imminent — finish only what's in hand; take on no new reasoning load (reasoning materially degraded)"),
    (float("inf"), "BLACK", "⚫", "STOP — hand off to a fresh session NOW; the next fan-out risks tripping lossy auto-compaction (reasoning unreliable)"),
]

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


def _claude_window() -> int:
    raw = os.environ.get("CONTEXT_GAUGE_WINDOW") or os.environ.get(
        "CLAUDE_CONTEXT_GAUGE_WINDOW", DEFAULT_CLAUDE_WINDOW
    )
    try:
        return int(raw)
    except (TypeError, ValueError):
        return DEFAULT_CLAUDE_WINDOW


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


def _fmt_k(n) -> str:
    n = float(n)
    return f"{n/1000:.0f}K" if n < 1_000_000 else f"{n/1_000_000:.2f}M"


def band_for(working):
    for ceiling, name, emoji, action in BANDS:
        if working < ceiling:
            return name, emoji, action
    return BANDS[-1][1], BANDS[-1][2], BANDS[-1][3]


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


def reading_claude(transcript_path):
    """Return (working, total, floor, window, model) or None."""
    first, last = scan_usage(transcript_path)
    if last is None:
        return None
    total = compute_fill(last)
    floor = compute_fill(first) if first is not None else 0
    working = max(0, total - floor)
    return working, total, floor, _claude_window(), ""


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


def save_floor(session_id: str, floor: int, window: int, model: str, compaction_count: int):
    path = _floor_path(session_id)
    if path is None:
        return
    payload = json.dumps({
        "floor": int(floor),
        "window": int(window),
        "model": model or "",
        "compaction_count": int(compaction_count or 0),
        "seeded_at": time.time(),
    }, indent=2) + "\n"
    try:
        d = _floor_dir()
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
    window = int(sig.get("contextWindowTokens") or 0) or DEFAULT_GROK_WINDOW
    models = sig.get("modelsUsed") or []
    model = safe_model(sig.get("primaryModelId") or (models[0] if models else ""))
    cc = int(sig.get("compactionCount") or 0)
    floor = resolve_floor(session_id, total, window, model, cc)
    working = max(0, total - floor)
    return working, total, floor, window, model


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
    name, emoji, action = band_for(working)
    window = window or _claude_window()
    pct = (total / window * 100.0) if window else 0.0
    compaction = " · compaction near ⚠" if pct >= 80 else ""
    model_bit = f" · model {model}" if model else ""
    return (
        f"⛽ CONTEXT FUEL {_fmt_k(working)} working set ({emoji} {name}) "
        f"[{_fmt_k(total)} total − {_fmt_k(floor)} floor] "
        f"· {pct:.0f}% of {_fmt_k(window)} window{compaction}{model_bit} "
        f"· reasoning: {action}. "
        f"[bands: \U0001F7E2<{_fmt_k(GREEN_MAX)} \U0001F7E1<{_fmt_k(YELLOW_MAX)} "
        f"\U0001F7E0<{_fmt_k(ORANGE_MAX)} \U0001F534<{_fmt_k(RED_MAX)} ⚫≥{_fmt_k(RED_MAX)}; "
        f"mechanical/retrieval work gets ~2-3× headroom]"
    )


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


def band_segment(working):
    name, emoji, _action = band_for(working)
    color = _ANSI.get(name, "")
    seg = f"{color}⛽ {emoji} {name} {_fmt_k(working)}{_RESET}"
    if name == "BLACK":
        seg += f" {color}⚑ HANDOFF NOW{_RESET}"
    elif name in ("ORANGE", "RED"):
        seg += f" {color}⚑ handoff soon{_RESET}"
    return seg


def statusline_claude(transcript_path, model=""):
    tail = model or ""
    if _disabled():
        return tail
    suffix = (_SEP + tail) if tail else ""
    r = reading_claude(transcript_path) if transcript_path else None
    if r is None:
        return f"{_DIM}⛽ …{_RESET}{suffix}"
    working, _t, _f, _w, _m = r
    return band_segment(working) + suffix


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
        for working in (10_000, 60_000, 120_000, 200_000, 300_000):
            print(f"bar   : {band_segment(working)}")
            print(f"inject: {gauge_line(working, working + floor, floor, window=500_000, model='grok-4.5')}")
            print()
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

    if is_hook or is_grok:
        try:
            if _disabled():
                return 0
            r = None
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
            if r is None and tp:
                r = reading_claude(tp)
            if r is None:
                return 0
            emit_hook(gauge_line(*r), event)
        except Exception:
            pass
        return 0

    # Claude statusLine mode (stdin is statusLine payload, not a hook)
    try:
        model = (data.get("model") or {}).get("display_name", "")
        _safe_write(statusline_claude(tp, model))
    except Exception:
        _safe_write("")
    return 0


if __name__ == "__main__":
    sys.exit(main())
