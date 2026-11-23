import unittest
from unittest.mock import patch

import pandas as pd

from stock_analysis import fund_charts


class FundChartsTest(unittest.TestCase):
    def test_payload_keeps_missing_sessions_and_does_not_infer_volume(self):
        sessions = pd.to_datetime(["2025-01-02", "2025-01-03", "2025-01-06"])
        frame = pd.DataFrame({"open": [100, 102], "high": [102, 103], "low": [99, 101],
                              "close": [101, 102], "volume": [900, 400]}, index=sessions[[0, 2]])
        coverage = {"first": "2025-01-02", "last": "2025-01-06", "count": 2, "internal_gaps": 1,
                    "ohlc_rows": 2, "volume_unit": None, "source_url": "https://example.test",
                    "permission": "research"}
        result = fund_charts.index_payload("110022", {"code": "399997", "name": "测试指数"},
                                           frame, coverage, "2025-01-06")
        self.assertEqual(len(result["rows"]), 3)
        self.assertIsNone(result["rows"][1]["close"])
        self.assertNotIn("volume", result["rows"][0])
        self.assertIsNone(result["rows"][2]["MA5"])

    def test_precomputed_ma_uses_history_outside_display_period(self):
        dates = fund_charts.session_index("2025-01-02", "2025-08-01")
        closes = pd.Series(range(101, 101 + len(dates)), index=dates, dtype=float)
        frame = pd.DataFrame({"close": closes, "volume": 1000.0}, index=dates)
        coverage = {"first": "2025-01-02", "last": "2025-08-01", "count": len(dates),
                    "internal_gaps": 0, "ohlc_rows": 0, "volume_unit": "股",
                    "source_url": "https://example.test", "volume_unit_evidence": "https://example.test/unit",
                    "permission": "authorized_for_research"}
        result = fund_charts.index_payload("110022", {"code": "399997", "name": "测试指数"},
                                           frame, coverage, "2025-08-01")
        latest = result["rows"][-1]
        self.assertAlmostEqual(latest["MA60"], closes.tail(60).mean())
        self.assertIsNone(latest["open"])
        self.assertEqual(latest["VOL5"], 1000)
        self.assertEqual(latest["VOL10"], 1000)
        self.assertEqual(result["source"]["volume_unit_evidence"], coverage["volume_unit_evidence"])

    def test_history_requests_cannot_turn_into_general_index_proxy(self):
        context = ({"code": "110022"}, {}, {"sectors": [{"code": "399997"}]}, {})
        with patch("stock_analysis.fund_charts.fund_context", return_value=context):
            with self.assertRaisesRegex(ValueError, "可用关联结果"):
                fund_charts.sector_history("110022", "000300")
