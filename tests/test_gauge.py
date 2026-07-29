"""Tests for context-gauge — multi-harness statusLine + UserPromptSubmit gauge.

Layers:
  - unit: band_for / compute_fill / scan_usage / Claude + Grok readings
  - regression: aborted-turn stub, tail-blind-spot, Grok floor sticky + compact reseed
  - black-box: run the script binary; assert FAIL-OPEN (always rc 0)

Run:  python3 -m pytest tests/ -v      (or)      python3 tests/test_gauge.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "context-gauge")

_loader = SourceFileLoader("cg", SCRIPT)
_spec = importlib.util.spec_from_loader("cg", _loader)
gauge = importlib.util.module_from_spec(_spec)
_loader.exec_module(gauge)


def _assistant_line(cache_read, input_tokens=2, cache_creation=0, sidechain=False, meta=False, pad=0):
    obj = {
        "type": "assistant",
        "message": {"role": "assistant", "usage": {
            "input_tokens": input_tokens,
            "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_creation,
            "output_tokens": 500,
        }},
    }
    if sidechain:
        obj["isSidechain"] = True
    if meta:
        obj["isMeta"] = True
    if pad:
        obj["_pad"] = "x" * pad
    return json.dumps(obj)


def _tool_result_line(pad):
    return json.dumps({"type": "user", "message": {"role": "user", "content": "x" * pad}})


def _write_transcript(lines):
    fd, path = tempfile.mkstemp(suffix=".jsonl")
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    return path


def run(stdin_obj=None, extra_args=None, env_extra=None, raw_stdin=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    cmd = [sys.executable, SCRIPT] + (extra_args or [])
    stdin = raw_stdin if raw_stdin is not None else (json.dumps(stdin_obj) if stdin_obj is not None else "")
    r = subprocess.run(cmd, input=stdin, capture_output=True, text=True, env=env)
    return r.returncode, r.stdout, r.stderr


class TestBands(unittest.TestCase):
    def test_working_set_boundaries(self):
        cases = [
            (0, "GREEN"), (39_999, "GREEN"),
            (40_000, "YELLOW"), (89_999, "YELLOW"),
            (90_000, "ORANGE"), (149_999, "ORANGE"),
            (150_000, "RED"), (249_999, "RED"),
            (250_000, "BLACK"), (900_000, "BLACK"),
        ]
        for working, expect in cases:
            name, _, _ = gauge.band_for(working)
            self.assertEqual(name, expect, f"working={working} -> {name}, expected {expect}")

    def test_compute_fill_excludes_output(self):
        usage = {"input_tokens": 10, "cache_read_input_tokens": 100,
                 "cache_creation_input_tokens": 5, "output_tokens": 9999}
        self.assertEqual(gauge.compute_fill(usage), 115)

    def test_compute_fill_missing_fields(self):
        self.assertEqual(gauge.compute_fill({}), 0)
        self.assertEqual(gauge.compute_fill({"input_tokens": 7}), 7)

    def test_gauge_line_shape(self):
        line = gauge.gauge_line(120_000, 180_000, 60_000)
        self.assertIn("CONTEXT FUEL", line)
        self.assertIn("ORANGE", line)
        self.assertIn("working set", line)
        self.assertIn("60K floor", line)


class TestClaudeReading(unittest.TestCase):
    def test_working_set_subtracts_floor(self):
        path = _write_transcript([
            _assistant_line(60_000),
            _assistant_line(120_000),
            _assistant_line(163_000),
        ])
        try:
            working, total, floor, _w, _m = gauge.reading_claude(path)
            self.assertEqual(floor, 60_002)
            self.assertEqual(total, 163_002)
            self.assertEqual(working, 103_000)
            self.assertEqual(gauge.band_for(working)[0], "ORANGE")
        finally:
            os.unlink(path)

    def test_born_green_first_turn(self):
        path = _write_transcript([_assistant_line(62_000)])
        try:
            working, _total, _floor, _w, _m = gauge.reading_claude(path)
            self.assertEqual(working, 0)
            self.assertEqual(gauge.band_for(working)[0], "GREEN")
        finally:
            os.unlink(path)

    def test_no_usage_returns_none(self):
        path = _write_transcript([_tool_result_line(10)])
        try:
            self.assertIsNone(gauge.reading_claude(path))
        finally:
            os.unlink(path)

    # back-compat alias used by older mental models
    def test_reading_alias(self):
        self.assertTrue(hasattr(gauge, "reading_claude"))


class TestClaudeScanUsage(unittest.TestCase):
    def test_sidechain_and_meta_ignored(self):
        path = _write_transcript([
            _assistant_line(60_000),
            _assistant_line(900_000, sidechain=True),
            _assistant_line(120_000),
            _assistant_line(800_000, meta=True),
        ])
        try:
            first, last = gauge.scan_usage(path)
            self.assertEqual(gauge.compute_fill(first), 60_002)
            self.assertEqual(gauge.compute_fill(last), 120_002)
        finally:
            os.unlink(path)

    def test_aborted_turn_stub_does_not_produce_a_false_green(self):
        path = _write_transcript([
            _assistant_line(60_000),
            _assistant_line(280_000),
            _assistant_line(0, input_tokens=0),
        ])
        try:
            first, last = gauge.scan_usage(path)
            self.assertEqual(gauge.compute_fill(first), 60_002)
            self.assertEqual(gauge.compute_fill(last), 280_002)
            working, total, _floor, _w, _m = gauge.reading_claude(path)
            self.assertEqual(total, 280_002)
            self.assertEqual(working, 220_000)
            self.assertNotEqual(gauge.band_for(working)[0], "GREEN")
        finally:
            os.unlink(path)

    def test_aborted_turn_stub_is_not_used_as_the_floor(self):
        path = _write_transcript([
            _assistant_line(0, input_tokens=0),
            _assistant_line(60_000),
            _assistant_line(120_000),
        ])
        try:
            first, _last = gauge.scan_usage(path)
            self.assertEqual(gauge.compute_fill(first), 60_002)
        finally:
            os.unlink(path)

    def test_all_turns_aborted_says_nothing(self):
        path = _write_transcript([
            _assistant_line(0, input_tokens=0),
            _assistant_line(0, input_tokens=0),
        ])
        try:
            self.assertIsNone(gauge.reading_claude(path))
        finally:
            os.unlink(path)

    def test_last_usage_far_from_eof_still_found(self):
        path = _write_transcript([
            _assistant_line(60_000),
            _assistant_line(170_000),
            _tool_result_line(800_000),
            _tool_result_line(10),
        ])
        try:
            first, last = gauge.scan_usage(path)
            self.assertIsNotNone(last)
            self.assertEqual(gauge.compute_fill(last), 170_002)
            w, _t, _f, _win, _m = gauge.reading_claude(path)
            self.assertEqual(w, 110_000)
        finally:
            os.unlink(path)


class TestGrokReading(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.floor_dir = Path(self._td.name)
        # patch module floor dir
        self._orig = gauge._floor_dir
        gauge._floor_dir = lambda: self.floor_dir  # type: ignore

    def tearDown(self):
        gauge._floor_dir = self._orig  # type: ignore
        self._td.cleanup()

    def test_floor_sticky_and_growth(self):
        sid = "sess-a"
        sig = {
            "contextTokensUsed": 100_000,
            "contextWindowTokens": 500_000,
            "primaryModelId": "grok-4.5",
            "compactionCount": 0,
            "turnCount": 1,
        }
        r1 = gauge.reading_grok_signals(sig, sid)
        self.assertEqual(r1[0], 0)       # working
        self.assertEqual(r1[2], 100_000)  # floor
        r2 = gauge.reading_grok_signals({**sig, "contextTokensUsed": 160_000}, sid)
        self.assertEqual(r2[0], 60_000)
        self.assertEqual(r2[2], 100_000)
        self.assertEqual(gauge.band_for(r2[0])[0], "YELLOW")

    def test_compact_reseeds_floor(self):
        sid = "sess-b"
        gauge.reading_grok_signals({
            "contextTokensUsed": 200_000,
            "contextWindowTokens": 500_000,
            "primaryModelId": "grok-4.5",
            "compactionCount": 0,
        }, sid)
        r = gauge.reading_grok_signals({
            "contextTokensUsed": 80_000,
            "contextWindowTokens": 500_000,
            "primaryModelId": "grok-4.5",
            "compactionCount": 1,
        }, sid)
        self.assertEqual(r[0], 0)
        self.assertEqual(r[2], 80_000)

    def test_zero_fill_skipped(self):
        self.assertIsNone(gauge.reading_grok_signals({
            "contextTokensUsed": 0,
            "contextWindowTokens": 500_000,
        }, "sess-c"))


class TestHookModeFailOpen(unittest.TestCase):
    def test_claude_valid_emits_envelope(self):
        path = _write_transcript([_assistant_line(60_000), _assistant_line(163_000)])
        try:
            rc, out, _ = run({"transcript_path": path, "hook_event_name": "UserPromptSubmit"})
            self.assertEqual(rc, 0)
            env = json.loads(out)
            self.assertEqual(env["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
            ctx = env["hookSpecificOutput"]["additionalContext"]
            self.assertIn("CONTEXT FUEL", ctx)
            self.assertIn("working set", ctx)
        finally:
            os.unlink(path)

    def test_grok_hook_envelope(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            # fake grok sessions layout
            sess = root / "sessions" / "home%2Fproj" / "sid-1"
            sess.mkdir(parents=True)
            (sess / "signals.json").write_text(json.dumps({
                "contextTokensUsed": 100_000,
                "contextWindowTokens": 500_000,
                "primaryModelId": "grok-4.5",
                "compactionCount": 0,
            }))
            # second turn growth: seed then grow via two runs with floor dir
            floor_dir = root / "floors"
            env = {
                "GROK_HOME": str(root),
                "CONTEXT_GAUGE_FLOOR_DIR": str(floor_dir),
                "GROK_SESSION_ID": "sid-1",
            }
            rc, out, _ = run(
                {"sessionId": "sid-1", "workspaceRoot": "/home/proj",
                 "hookEventName": "user_prompt_submit"},
                env_extra=env,
            )
            self.assertEqual(rc, 0)
            # first observation → working 0, still emits
            env1 = json.loads(out)
            self.assertIn("CONTEXT FUEL", env1["hookSpecificOutput"]["additionalContext"])

            (sess / "signals.json").write_text(json.dumps({
                "contextTokensUsed": 160_000,
                "contextWindowTokens": 500_000,
                "primaryModelId": "grok-4.5",
                "compactionCount": 0,
            }))
            rc2, out2, _ = run(
                {"sessionId": "sid-1", "workspaceRoot": "/home/proj",
                 "hookEventName": "UserPromptSubmit"},
                env_extra=env,
            )
            self.assertEqual(rc2, 0)
            ctx = json.loads(out2)["hookSpecificOutput"]["additionalContext"]
            self.assertIn("YELLOW", ctx)
            self.assertIn("60K working", ctx)

    def test_disable_emits_nothing(self):
        path = _write_transcript([_assistant_line(163_000)])
        try:
            rc, out, _ = run({"transcript_path": path, "hook_event_name": "UserPromptSubmit"},
                             env_extra={"CONTEXT_GAUGE_DISABLE": "1"})
            self.assertEqual(rc, 0)
            self.assertEqual(out.strip(), "")
        finally:
            os.unlink(path)

    def test_legacy_disable_alias(self):
        path = _write_transcript([_assistant_line(163_000)])
        try:
            rc, out, _ = run({"transcript_path": path, "hook_event_name": "UserPromptSubmit"},
                             env_extra={"CLAUDE_CONTEXT_GAUGE_DISABLE": "1"})
            self.assertEqual(rc, 0)
            self.assertEqual(out.strip(), "")
        finally:
            os.unlink(path)

    def test_malformed_stdin_rc0(self):
        rc, out, _ = run(raw_stdin="not json{{")
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip(), "")

    def test_missing_transcript_path_rc0_empty(self):
        rc, out, _ = run({"hook_event_name": "UserPromptSubmit"})
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip(), "")

    def test_nonexistent_transcript_rc0_empty(self):
        rc, out, _ = run({"transcript_path": "/no/such/file.jsonl", "hook_event_name": "UserPromptSubmit"})
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip(), "")

    def test_no_usage_yet_emits_nothing(self):
        path = _write_transcript([_tool_result_line(10)])
        try:
            rc, out, _ = run({"transcript_path": path, "hook_event_name": "UserPromptSubmit"})
            self.assertEqual(rc, 0)
            self.assertEqual(out.strip(), "")
        finally:
            os.unlink(path)

    def test_cli_transcript_missing_arg_is_fail_open(self):
        rc, _out, _ = run(extra_args=["--transcript"])
        self.assertEqual(rc, 0)


class TestStatuslineMode(unittest.TestCase):
    def test_renders_band_and_model(self):
        path = _write_transcript([_assistant_line(60_000), _assistant_line(163_000)])
        try:
            rc, out, _ = run({"transcript_path": path, "model": {"display_name": "Opus 4.8"}})
            self.assertEqual(rc, 0)
            self.assertIn("ORANGE", out)
            self.assertIn("Opus 4.8", out)
        finally:
            os.unlink(path)

    def test_no_assistant_turn_is_neutral(self):
        path = _write_transcript([_tool_result_line(10)])
        try:
            rc, out, _ = run({"transcript_path": path, "model": {"display_name": "Opus 4.8"}})
            self.assertEqual(rc, 0)
            self.assertIn("Opus 4.8", out)
            self.assertNotIn("ORANGE", out)
        finally:
            os.unlink(path)

    def test_disable_shows_model_only(self):
        path = _write_transcript([_assistant_line(60_000), _assistant_line(163_000)])
        try:
            rc, out, _ = run({"transcript_path": path, "model": {"display_name": "Opus 4.8"}},
                             env_extra={"CONTEXT_GAUGE_DISABLE": "1"})
            self.assertEqual(rc, 0)
            self.assertNotIn("ORANGE", out)
            self.assertIn("Opus 4.8", out)
        finally:
            os.unlink(path)

    def test_black_band_handoff_now(self):
        path = _write_transcript([_assistant_line(60_000), _assistant_line(360_000)])
        try:
            rc, out, _ = run({"transcript_path": path, "model": {"display_name": "Opus 4.8"}})
            self.assertEqual(rc, 0)
            self.assertIn("BLACK", out)
            self.assertIn("HANDOFF NOW", out)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
