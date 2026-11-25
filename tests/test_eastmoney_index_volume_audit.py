import json
import unittest
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from scripts.audit_eastmoney_index_volume import audit, compare_cached_csi, observation, session_index
from stock_analysis.sector_data import CSI_URL


class EastmoneyIndexVolumeAuditTest(unittest.TestCase):
    start, end = "2025-03-03", "2025-03-19"

    def setUp(self):
        self.dates = list(session_index(self.start, self.end).strftime("%Y-%m-%d"))
        self.klines = [f"{day},100,110,115,95,{i},9000" for i, day in enumerate(self.dates)]

    def payload(self, **changes):
        return json.dumps({"data": {"code": "399997", "name": "中证白酒", "market": 0,
                                    "klines": self.klines, **changes}})

    def test_index_market_identity_query_dates_and_independent_volumes(self):
        def get(url):
            query = parse_qs(urlsplit(url).query)
            self.assertEqual(query["secid"], ["0.399997"])
            self.assertEqual(query["beg"], ["20250303"])
            self.assertEqual(query["end"], ["20250319"])
            self.assertEqual(query["fqt"], ["0"])
            return self.payload()

        report = observation("399997", self.start, self.end, get=get)
        self.assertEqual(report["volume_zero_rows"], 1)
        self.assertEqual(report["missing_sessions"], 0)
        self.assertEqual(report["last_day_independent_check"], {"VOL5": 10, "VOL10": 7.5})
        self.assertEqual(report["samples"][self.end]["volume"], 12)
        self.assertEqual(report["samples"][self.end]["turnover"], 9000)

    def test_rejects_same_symbol_with_wrong_market_name_or_code(self):
        for changes in ({"market": 1}, {"market": False}, {"name": "白酒ETF"}, {"code": "000994"}):
            with self.subTest(changes=changes):
                report = observation("399997", self.start, self.end, get=lambda _: self.payload(**changes))
                self.assertEqual(report["status"], "identity_mismatch")

    def test_rejects_out_of_window_holidays_and_repeated_quotes(self):
        for day in ("2025-03-01", "2025-03-08", self.start):
            with self.subTest(day=day), self.assertRaisesRegex(ValueError, "out-of-window"):
                observation("399997", self.start, self.end,
                            get=lambda _: self.payload(klines=self.klines + [f"{day},100,110,115,95,10,9000"]))

    def test_gap_or_invalid_volume_restarts_window_without_losing_ohlc(self):
        affected = self.klines[-6]
        variants = (self.klines[:-6] + self.klines[-5:],
                    self.klines[:-6] + [affected.replace(",7,9000", ",-7,9000")] + self.klines[-5:])
        for lines, missing_sessions, invalid_volume in zip(variants, (1, 0), (0, 1)):
            with self.subTest(missing=missing_sessions, invalid=invalid_volume):
                report = observation("399997", self.start, self.end, get=lambda _: self.payload(klines=lines))
                self.assertEqual(report["last_day_independent_check"], {"VOL5": 10, "VOL10": None})
                self.assertEqual(report["missing_sessions"], missing_sessions)
                self.assertEqual(report["missing_or_invalid_volume"], invalid_volume)
                self.assertEqual(report["valid_ohlc_rows"], len(lines))

    def test_fetch_stop_and_unlicensed_observations_always_research_only(self):
        calls = []

        def get(url):
            calls.append(url)
            if len(calls) == 2:
                raise HTTPError(url, 429, "limited", None, None)
            return self.payload()

        result = audit(self.start, self.end, get=get)
        self.assertFalse(result["runtime_eligible"])
        self.assertEqual(len(calls), 2)
        self.assertEqual([v["status"] for v in result["indices"].values()],
                         ["observed", "access_restricted", "not_requested_after_restriction"])

    def test_cached_reference_requires_same_index_and_date_and_reports_conflicts(self):
        summary = observation("399997", self.start, self.end, get=lambda _: self.payload())
        row = {"open": 100, "high": 115, "low": 95, "close": 110, "tradingVol": 1200, "tradingValue": 0.00009}
        indices = {"399997": summary, "000994": summary}
        evidence = {"source": CSI_URL, "samples": {"399997": {self.end: {"csi": row}}}}
        self.assertEqual(compare_cached_csi(indices, evidence)["399997"][self.end]["status"], "matches_rounding")
        self.assertEqual(compare_cached_csi(indices, evidence)["000994"][self.end]["status"], "no_same_day_reference")
        row["tradingVol"] = 1300
        self.assertEqual(compare_cached_csi(indices, evidence)["399997"][self.end]["status"], "source_conflict")
