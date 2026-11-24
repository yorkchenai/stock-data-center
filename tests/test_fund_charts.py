import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
import json

import pandas as pd

from stock_analysis import fund_charts, sector_data


ENTRY = {"code": "399997", "name": "测试指数"}
EVIDENCE = "https://example.test/unit"
VOLUME_SOURCE = {"raw_unit": "手", "raw_field": "tradingVol", "conversion_factor": 100,
                 "scope": "index_constituents", "permission": "authorized_local_use"}


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
                    "source_url": "https://example.test", "volume_unit_evidence": EVIDENCE,
                    "volume_source": VOLUME_SOURCE,
                    "permission": "authorized_for_research"}
        result = fund_charts.index_payload("110022", {"code": "399997", "name": "测试指数"},
                                           frame, coverage, "2025-08-01")
        latest = result["rows"][-1]
        self.assertAlmostEqual(latest["MA60"], closes.tail(60).mean())
        self.assertIsNone(latest["open"])
        self.assertEqual(latest["VOL5"], 100000)
        self.assertEqual(latest["VOL10"], 100000)
        self.assertEqual(result["source"]["volume_unit_evidence"], coverage["volume_unit_evidence"])

    def test_volume_uses_contiguous_exchange_sessions_and_zero_is_valid(self):
        days = fund_charts.session_index("2025-01-02", "2025-03-04")[:39]
        last = days[-1].date().isoformat()
        raw = {day: float(i) for i, day in enumerate(days)}
        del raw[days[7]]
        raw[days[19]] = -5
        raw[days[29]] = float("nan")
        frame = pd.DataFrame({"volume": pd.Series(raw), "close": 150.0})
        coverage = {"first": "2025-01-02", "last": last, "count": len(frame), "internal_gaps": 1,
                    "ohlc_rows": 0, "volume_unit": "股", "volume_source": VOLUME_SOURCE,
                    "volume_unit_evidence": EVIDENCE, "source_url": sector_data.CSI_URL, "permission": "test"}
        payload = fund_charts.index_payload("110022", ENTRY, frame, coverage, last)
        self.assertEqual(payload["quality"]["volume_status"], "available")
        self.assertEqual(payload["source"]["volume"], VOLUME_SOURCE)
        valid = {day: v * 100 for day, v in raw.items() if v >= 0}
        for i, (day, row) in enumerate(zip(days, payload["rows"]), start=1):
            self.assertEqual(row["volume"], valid.get(day))
            for window in (5, 10):
                chosen = days[max(0, i-window):i]
                expected = sum(valid[d] for d in chosen) / window if len(chosen) == window and all(d in valid for d in chosen) else None
                self.assertEqual(row[f"VOL{window}"], expected)

    def test_bad_unit_multiplier_or_permission_does_not_hide_price(self):
        day = "2025-01-02"
        frame = pd.DataFrame({"open": [100], "high": [104], "low": [99], "close": [103], "volume": [400]},
                             index=pd.to_datetime([day]))
        coverage = {"first": day, "last": day, "count": 1, "internal_gaps": 0, "ohlc_rows": 1,
                    "volume_unit": "股", "volume_unit_evidence": EVIDENCE, "source_url": sector_data.CSI_URL,
                    "permission": "test"}
        for wrong in ({"conversion_factor": 1}, {"raw_unit": "吨"}, {"raw_unit": "份"},
                      {"permission": "license_unverified"}, {"raw_field": "tradingValue"}, {"scope": "ETF"}):
            with self.subTest(wrong=wrong):
                result = fund_charts.index_payload("110022", ENTRY, frame,
                                                   {**coverage, "volume_source": {**VOLUME_SOURCE, **wrong}}, day)
                self.assertIsNone(result["volume_unit"])
                self.assertEqual(result["quality"]["volume_status"], "invalid_provenance")
                self.assertEqual(result["rows"][0]["open"], 100)
                self.assertNotIn("volume", result["rows"][0])

    def test_csi_records_validate_identity_dates_and_raw_volume(self):
        def row(day, volume):
            return {"indexCode": ENTRY["code"], "indexNameCnAll": ENTRY["name"], "tradeDate": day,
                    "open": 100, "high": 104, "low": 99, "close": 103, "tradingVol": volume, "tradingValue": 200}

        start, end = "2025-01-02", "2025-01-08"
        rows = [row("20250108", None), row("20250107", True), row("20250106", -1), row("20250102", 0)]
        frame = sector_data.csi_history(ENTRY, start, end, get=lambda _: json.dumps({"data": rows}))
        self.assertEqual(frame.volume.dropna().tolist(), [0])
        self.assertEqual(frame.turnover.tolist(), [200]*4)
        self.assertEqual(sector_data.summarize_index(frame, start, end)["volume_coverage"],
                         {"first": start, "last": start, "zero_rows": 1, "invalid_rows": 2,
                          "missing_field_rows": 1, "missing_sessions": 4})
        for bad, reason in ((rows+rows[:1], "invalid_dates"), ([row("2025102", 1)], "date_format"),
                            ([{**rows[0], "indexCode": "000991"}], "identity_mismatch")):
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, reason):
                sector_data.csi_history(ENTRY, start, end, get=lambda _: json.dumps({"data": bad}))

    def test_index_timeout_retries_once_and_restriction_stops_requests(self):
        with patch("stock_analysis.sector_data.sleep"), patch("stock_analysis.sector_data.csi_history") as provider, \
                patch("stock_analysis.sector_data.read_catalog", return_value={"first": {}, "second": {}, "third": {}}):
            provider.side_effect = [URLError(TimeoutError()), URLError(TimeoutError()),
                                    HTTPError("https://example.test", 429, "limited", None, None)]
            frames, report = sector_data.collect_indices("2025-01-02", "2025-01-08")
        self.assertEqual(provider.call_count, 3)
        self.assertEqual(frames, {})
        self.assertEqual([entry["status"] for entry in report.values()],
                         ["network_error", "access_restricted", "not_requested_after_restriction"])

    def test_history_requests_cannot_turn_into_general_index_proxy(self):
        context = ({"code": "110022"}, {}, {"sectors": [{"code": "399997"}]}, {})
        with patch("stock_analysis.fund_charts.fund_context", return_value=context):
            with self.assertRaisesRegex(ValueError, "可用关联结果"):
                fund_charts.sector_history("110022", "000300")
