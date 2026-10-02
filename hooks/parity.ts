// Cases both implementations must agree on, with what context_gauge.py answers for
// each. tests/test_gauge.py reads PARITY below as JSON and runs it through the Python
// module; gauge.test.ts runs it through gauge.ts. Keep it strict JSON: quoted keys, no
// comments or trailing commas inside it.
//
// bands: band_segment() with its colour codes removed, and the band and axis it chose.
// fitted: what _tuned() accepts from a thresholds.json, axis by axis (the four
// ceilings; the Infinity after them is implied).

export const PARITY = {
  "bands": [
    {"working": 0, "total": 60000, "window": null, "name": "GREEN", "source": "working set", "text": "⛽ 🟢 GREEN 0K"},
    {"working": 39999, "total": 99999, "window": null, "name": "GREEN", "source": "working set", "text": "⛽ 🟢 GREEN 40K"},
    {"working": 40000, "total": 100000, "window": null, "name": "YELLOW", "source": "working set", "text": "⛽ 🟡 YELLOW 40K"},
    {"working": 89999, "total": 149999, "window": null, "name": "YELLOW", "source": "working set", "text": "⛽ 🟡 YELLOW 90K"},
    {"working": 90000, "total": 150000, "window": null, "name": "ORANGE", "source": "working set", "text": "⛽ 🟠 ORANGE 90K ⚑ checkpoint"},
    {"working": 149999, "total": 209999, "window": null, "name": "ORANGE", "source": "working set", "text": "⛽ 🟠 ORANGE 150K ⚑ checkpoint"},
    {"working": 150000, "total": 210000, "window": null, "name": "RED", "source": "working set", "text": "⛽ 🔴 RED 150K ⚑ handoff soon"},
    {"working": 249999, "total": 309999, "window": null, "name": "RED", "source": "working set", "text": "⛽ 🔴 RED 250K ⚑ handoff soon"},
    {"working": 250000, "total": 310000, "window": null, "name": "BLACK", "source": "working set", "text": "⛽ ⚫ BLACK 250K ⚑ HANDOFF NOW"},
    {"working": 900000, "total": 960000, "window": null, "name": "BLACK", "source": "working set", "text": "⛽ ⚫ BLACK 900K ⚑ HANDOFF NOW"},
    {"working": 10000, "total": 499999, "window": 1000000, "name": "GREEN", "source": "both", "text": "⛽ 🟢 GREEN 10K · 50% of 1M"},
    {"working": 10000, "total": 500000, "window": 1000000, "name": "YELLOW", "source": "window ratio", "text": "⛽ 🟡 YELLOW 10K · 50% of 1M"},
    {"working": 10000, "total": 699999, "window": 1000000, "name": "YELLOW", "source": "window ratio", "text": "⛽ 🟡 YELLOW 10K · 70% of 1M"},
    {"working": 10000, "total": 700000, "window": 1000000, "name": "ORANGE", "source": "window ratio", "text": "⛽ 🟠 ORANGE 10K · 70% of 1M ⚑ compaction near"},
    {"working": 10000, "total": 849999, "window": 1000000, "name": "ORANGE", "source": "window ratio", "text": "⛽ 🟠 ORANGE 10K · 85% of 1M ⚑ compaction near"},
    {"working": 10000, "total": 850000, "window": 1000000, "name": "RED", "source": "window ratio", "text": "⛽ 🔴 RED 10K · 85% of 1M ⚑ compaction imminent"},
    {"working": 10000, "total": 949999, "window": 1000000, "name": "RED", "source": "window ratio", "text": "⛽ 🔴 RED 10K · 95% of 1M ⚑ compaction imminent"},
    {"working": 10000, "total": 950000, "window": 1000000, "name": "BLACK", "source": "window ratio", "text": "⛽ ⚫ BLACK 10K · 95% of 1M ⚑ HANDOFF NOW"},
    {"working": 120000, "total": 180000, "window": 200000, "name": "RED", "source": "window ratio", "text": "⛽ 🔴 RED 120K · 90% of 200K ⚑ compaction imminent"},
    {"working": 100000, "total": 160000, "window": 200000, "name": "ORANGE", "source": "both", "text": "⛽ 🟠 ORANGE 100K · 80% of 200K ⚑ compaction near"},
    {"working": 160000, "total": 170000, "window": 200000, "name": "RED", "source": "both", "text": "⛽ 🔴 RED 160K · 85% of 200K ⚑ compaction imminent"},
    {"working": 200000, "total": 260000, "window": 1000000, "name": "RED", "source": "working set", "text": "⛽ 🔴 RED 200K · 26% of 1M ⚑ handoff soon"},
    {"working": 300000, "total": 360000, "window": 1000000, "name": "BLACK", "source": "working set", "text": "⛽ ⚫ BLACK 300K · 36% of 1M ⚑ HANDOFF NOW"},
    {"working": 12500, "total": 72500, "window": null, "name": "GREEN", "source": "working set", "text": "⛽ 🟢 GREEN 12K"},
    {"working": 13500, "total": 73500, "window": null, "name": "GREEN", "source": "working set", "text": "⛽ 🟢 GREEN 14K"},
    {"working": 999500, "total": 1059500, "window": null, "name": "BLACK", "source": "working set", "text": "⛽ ⚫ BLACK 1000K ⚑ HANDOFF NOW"},
    {"working": 1125000, "total": 1185000, "window": 2000000, "name": "BLACK", "source": "working set", "text": "⛽ ⚫ BLACK 1.12M · 59% of 2M ⚑ HANDOFF NOW"},
    {"working": 20000, "total": 225000, "window": 1000000, "name": "GREEN", "source": "both", "text": "⛽ 🟢 GREEN 20K · 22% of 1M"},
    {"working": 20000, "total": 125000, "window": 1000000, "name": "GREEN", "source": "both", "text": "⛽ 🟢 GREEN 20K · 12% of 1M"},
    {"working": 20000, "total": 135000, "window": 1000000, "name": "GREEN", "source": "both", "text": "⛽ 🟢 GREEN 20K · 14% of 1M"},
    {"working": 60000, "total": 120000, "window": 1500000, "name": "YELLOW", "source": "working set", "text": "⛽ 🟡 YELLOW 60K · 8% of 1.5M"},
    {"working": 0, "total": 0, "window": 200000, "name": "GREEN", "source": "working set", "text": "⛽ 🟢 GREEN 0K"}
  ],
  "fitted": [
    {"text": "{\"working\": {\"green_max\": 60000, \"yellow_max\": 120000, \"orange_max\": 200000, \"red_max\": 320000}}", "expect": {"working": [60000, 120000, 200000, 320000]}},
    {"text": "{\"ratio\": {\"green_max\": 0.4, \"yellow_max\": 0.6, \"orange_max\": 0.8, \"red_max\": 0.9}}", "expect": {"ratio": [0.4, 0.6, 0.8, 0.9]}},
    {"text": "{\"working\": {\"green_max\": 60000, \"yellow_max\": 120000, \"orange_max\": 200000, \"red_max\": 320000}, \"ratio\": {\"green_max\": 0.4, \"yellow_max\": 0.6, \"orange_max\": 0.8, \"red_max\": 0.9}}", "expect": {"working": [60000, 120000, 200000, 320000], "ratio": [0.4, 0.6, 0.8, 0.9]}},
    {"text": "{\"working\": {\"green_max\": 40000, \"yellow_max\": 30000, \"orange_max\": 200000, \"red_max\": 320000}}", "expect": {}},
    {"text": "{\"working\": {\"green_max\": 40000, \"yellow_max\": 40000, \"orange_max\": 200000, \"red_max\": 320000}}", "expect": {}},
    {"text": "{\"working\": {\"green_max\": 0, \"yellow_max\": 40000, \"orange_max\": 200000, \"red_max\": 320000}}", "expect": {}},
    {"text": "{\"ratio\": {\"green_max\": -0.1, \"yellow_max\": 0.6, \"orange_max\": 0.8, \"red_max\": 0.9}}", "expect": {}},
    {"text": "{\"working\": {\"green_max\": 40000, \"yellow_max\": 90000, \"orange_max\": 150000}}", "expect": {}},
    {"text": "{\"working\": {\"green_max\": null, \"yellow_max\": 90000, \"orange_max\": 150000, \"red_max\": 250000}}", "expect": {}},
    {"text": "{\"working\": {\"green_max\": \"60000\", \"yellow_max\": \" 1.2e5 \", \"orange_max\": \"200_000\", \"red_max\": 320000}}", "expect": {"working": [60000, 120000, 200000, 320000]}},
    {"text": "{\"working\": {\"green_max\": \"6O000\", \"yellow_max\": 120000, \"orange_max\": 200000, \"red_max\": 320000}}", "expect": {}},
    {"text": "{\"working\": {\"green_max\": [60000], \"yellow_max\": 120000, \"orange_max\": 200000, \"red_max\": 320000}}", "expect": {}},
    {"text": "{\"ratio\": {\"green_max\": true, \"yellow_max\": 2, \"orange_max\": 3, \"red_max\": 4}}", "expect": {"ratio": [1, 2, 3, 4]}},
    {"text": "{\"ratio\": {\"green_max\": \".5\", \"yellow_max\": \"6.\", \"orange_max\": \"7\", \"red_max\": \"8\"}}", "expect": {"ratio": [0.5, 6, 7, 8]}},
    {"text": "{\"working\": \"60000\"}", "expect": {}},
    {"text": "[{\"green_max\": 60000, \"yellow_max\": 120000, \"orange_max\": 200000, \"red_max\": 320000}]", "expect": {}},
    {"text": "{\"working\": {\"green_max\": 60000, \"yellow_max\": 120000, \"orange_max\": 200000, \"red_max\": 320000}, \"ratio\": {\"green_max\": 0.9, \"yellow_max\": 0.6, \"orange_max\": 0.8, \"red_max\": 0.95}}", "expect": {"working": [60000, 120000, 200000, 320000]}},
    {"text": "not json", "expect": {}},
    {"text": "", "expect": {}}
  ]
}
