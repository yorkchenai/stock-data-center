"""Cross-language numerical checks; artificial sequences are test fixtures only."""
from pathlib import Path
import json
import shutil
import subprocess
from tempfile import TemporaryDirectory
from unittest import TestCase, skipUnless

import numpy as np
import pandas as pd

from stock_analysis.indicators import calculate_indicators
from stock_analysis.pages import build_pages
from stock_analysis.web import INDICATOR_FIELDS, ROOT


def browser_indicators(frame):
    daily = frame.assign(date=pd.to_datetime(frame.date).dt.strftime("%Y-%m-%d"))
    result = subprocess.run(
        ["node", str(ROOT / "scripts/calculate_browser_indicators.mjs")],
        input=daily.to_json(orient="records", double_precision=15),
        text=True, capture_output=True, check=True,
    )
    return json.loads(result.stdout)


@skipUnless(shutil.which("node"), "Node required for Python/JavaScript parity tests")
class BrowserEngineTests(TestCase):
    def assert_parity(self, frame):
        expected = calculate_indicators(frame)
        actual = pd.DataFrame(browser_indicators(frame))
        self.assertEqual(len(actual), len(frame))
        for field in INDICATOR_FIELDS:
            with self.subTest(field=field):
                # Numeric tolerance includes only floating point accumulation;
                # null masks and raw daily input values must match exactly.
                np.testing.assert_array_equal(actual[field].isna(), expected[field].isna())
                np.testing.assert_allclose(actual[field].astype(float), expected[field], rtol=1e-12, atol=1e-9, equal_nan=True)
        for field in ["open", "close", "high", "low", "volume_lots", "turnover_cny"]:
            np.testing.assert_array_equal(actual[field], frame[field])

    def test_entire_real_kechuang_history_matches_python(self):
        self.assert_parity(pd.read_csv(ROOT / "results/000688_daily.csv"))

    def test_warmup_boundaries_flat_rising_falling_and_oscillating(self):
        for size in [1, 6, 14, 15, 24, 27, 28, 60, 130]:
            for trend in ["flat", "up", "down", "oscillating"]:
                with self.subTest(size=size, trend=trend):
                    i = np.arange(size, dtype=float)
                    close = {"flat": np.full(size, 100.), "up": 100 + i, "down": 300 - i, "oscillating": 100 + np.sin(i) * 7}[trend]
                    frame = pd.DataFrame({"date": pd.bdate_range("2025-01-06", periods=size),
                        "open": close, "close": close, "high": close + (trend != "flat"),
                        "low": close - (trend != "flat"), "volume_lots": i * 1234.5, "turnover_cny": i * 23456.7})
                    self.assert_parity(frame)


class PagesBuildTests(TestCase):
    def test_relative_site_calendar_real_snapshot_and_no_overwrite(self):
        with TemporaryDirectory() as temporary:
            output = build_pages(Path(temporary) / "site", calendar_end="2026-11-30")
            html = (output / "index.html").read_text()
            self.assertIn('data-mode="pages"', html)
            self.assertIn('src="./app.mjs"', html)
            self.assertTrue((output / "providers.mjs").exists())
            self.assertTrue((output / ".nojekyll").exists())
            calendar = json.loads((output / "calendar.json").read_text())
            self.assertEqual(calendar['end'], "2026-11-30")
            self.assertIn("2020-07-01", calendar['sessions'])
            self.assertNotIn("2026-11-22", calendar['sessions'])
            payload = json.loads((output / "api/demo").read_text())
            self.assertTrue(payload['snapshot'])
            self.assertFalse(payload['live_analysis'])
            self.assertEqual(len(payload['rows']), 1551)
            with self.assertRaises(FileExistsError):
                build_pages(output, calendar_end="2026-11-30")
