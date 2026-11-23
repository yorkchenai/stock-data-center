from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from io import StringIO
import json
from threading import Event
import unittest
from unittest.mock import patch
from urllib.error import URLError

from stock_analysis.funds import assignment, coalesce, load_fund, nav_event, parse_catalog, parse_disclosed_csv, parse_history


def epoch(day):
    return datetime.fromisoformat(day + "T00:00:00+08:00").timestamp() * 1000


def history(rows, code="000001", name="合成测试基金", accumulated=None):
    fields = {"fS_code": code, "fS_name": name, "Data_netWorthTrend": rows,
              "Data_ACWorthTrend": [[row["x"], value] for row, value in zip(rows, accumulated if accumulated is not None else [10] * len(rows))
                                    if value is not None]}
    return "".join(f"var {key} = {json.dumps(value)};\n" for key, value in fields.items())


class FundProviderTests(unittest.TestCase):
    def setUp(self):
        self.retrieval = datetime(2025, 1, 9, tzinfo=timezone.utc)
        self.rows = [
            {"x": epoch("2025-01-02"), "y": 1.5, "unitMoney": "", "equityReturn": 0},
            {"x": epoch("2025-01-03"), "y": 1.45, "unitMoney": "分红：每10份派现金1.0元", "equityReturn": 3.33},
            {"x": epoch("2025-01-06"), "y": .75, "unitMoney": "拆分：每份折算2份", "equityReturn": 3.45},
        ]

    def test_cash_and_split_do_not_create_artificial_nav_losses(self):
        data = parse_history(history(self.rows), "000001", {"category": "mixed"}, self.retrieval)
        rows = data["rows"]
        self.assertEqual(data["kind"], "off_market_fund")
        self.assertEqual(data["return_basis"], "event_reinvested")
        self.assertEqual(data["valuation_frequency"], "daily")
        self.assertEqual([row["date"] for row in rows], ["2025-01-02", "2025-01-03", "2025-01-06"])
        self.assertEqual(rows[1]["cash_distribution"], .1)
        self.assertEqual(rows[2]["split_factor"], 2)
        self.assertEqual(rows[2]["accumulated_nav"], 10)
        self.assertAlmostEqual(rows[2]["return_index"], (1.45 + .1) / 1.5 * (.75 * 2) / 1.45)

    def test_ambiguous_events_and_conflicting_growth_remain_missing(self):
        self.rows[1]["unitMoney"] = "来源字段未说明折算比例"
        self.rows[2]["equityReturn"] = -48.27
        data = parse_history(history(self.rows), "000001", retrieved_at=self.retrieval)
        self.assertIsNone(data["rows"][1]["return_index"])
        self.assertIsNone(data["rows"][2]["return_index"])
        self.assertEqual(data["rows"][1]["return_issue"], "unrecognized_event")
        self.assertEqual(data["rows"][2]["return_issue"], "growth_mismatch")
        self.assertIsNone(nav_event(None))
        self.assertIsNone(nav_event("每0份派现金2.0元"))

    def test_cash_placeholder_uses_cumulative_offset_and_daily_growth(self):
        rows = [
            {"x": epoch("2025-01-02"), "y": 1.2, "unitMoney": ""},
            {"x": epoch("2025-01-03"), "y": 1.14, "unitMoney": "分红：每10份派现金元", "equityReturn": "0.83%"},
            {"x": epoch("2025-01-06"), "y": 1.16, "unitMoney": "", "equityReturn": "1.75"},
        ]
        data = parse_history(history(rows, accumulated=[2.0, 2.01, 2.03]), "000001", retrieved_at=self.retrieval)
        self.assertEqual(data["rows"][1]["cash_distribution_source"], "cumulative_nav_reconciled")
        self.assertEqual(data["rows"][1]["cash_distribution"], .07)
        self.assertAlmostEqual(data["rows"][1]["return_index"], 1.21 / 1.2)
        self.assertAlmostEqual(data["rows"][2]["return_index"], 1.21 / 1.2 * 1.16 / 1.14)
        self.assertIsNone(data["rows"][1]["return_issue"])

    def test_cash_placeholder_requires_both_fields_and_rejects_conflict(self):
        case = {"x": epoch("2025-01-03"), "y": 1.14, "unitMoney": "分红：每10份派现金元"}
        for growth, accumulated, issue in (
            (None, [2.3, 2.31], "cash_evidence_missing"),
            (0.67, [2.3, None], "cash_evidence_missing"),
            (-1.5, [2.3, 2.31], "cash_evidence_mismatch"),
            (0.0, [2.3, 2.24], "cash_evidence_mismatch"),
        ):
            with self.subTest(growth=growth, accumulated=accumulated):
                data = parse_history(history([self.rows[0], {**case, "equityReturn": growth}], accumulated=accumulated),
                                     "000001", retrieved_at=self.retrieval)
                self.assertEqual(data["rows"][1]["return_issue"], issue)
                self.assertIsNone(data["rows"][1]["return_index"])

    def test_cash_placeholder_after_split_cannot_use_cumulative_offset(self):
        rows = [self.rows[0], self.rows[2],
                {"x": epoch("2025-01-07"), "y": .72, "unitMoney": "分红：每10份派现金元", "equityReturn": 0}]
        rows[1] = {**rows[1], "equityReturn": 0}
        data = parse_history(history(rows, accumulated=[1.5, 1.5, 1.5]), "000001", retrieved_at=self.retrieval)
        self.assertEqual(data["rows"][1]["return_index"], 1.0)
        self.assertEqual(data["rows"][2]["return_issue"], "cash_after_split")

    def test_never_executes_source_script_or_accepts_the_wrong_symbol(self):
        self.assertEqual(assignment('var fS_name = "测试"; alert("external");', "fS_name"), "测试")
        self.assertEqual(assignment('/*基金名称*/var fS_name = "测试";', "fS_name"), "测试")
        with self.assertRaisesRegex(ValueError, "不是 JSON 常量"):
            assignment('var fS_name = "a" + "b";', "fS_name")
        with self.assertRaisesRegex(ValueError, "不同的基金代码"):
            parse_history(history(self.rows, "000002"), "000001", retrieved_at=self.retrieval)
        with self.assertRaisesRegex(ValueError, "场外基金"):
            parse_history(history(self.rows, name="测试ETF"), "000001", retrieved_at=self.retrieval)
        with self.assertRaisesRegex(ValueError, "非递增"):
            parse_history(history([self.rows[-1], self.rows[0]]), "000001", retrieved_at=self.retrieval)

    def test_catalog_keeps_etf_linked_funds_and_classifies_special_types(self):
        records = parse_catalog('var r = ' + json.dumps([
            ["000001", "A", "测试ETF联接A", "指数型", "A1"],
            ["510000", "B", "测试ETF", "指数型", "B1"],
            ["123456", "C", "测试货币", "货币型", "C1"],
            ["654321", "D", "测试海外", "QDII-混合", "D1"],
            ["234567", "E", "测试债券", "债券型-混合一级", "E1"],
        ]) + ';')
        self.assertEqual(set(records), {"000001", "123456", "654321", "234567"})
        self.assertEqual(records["000001"]["category"], "index")
        self.assertEqual(records["123456"]["category"], "money")
        self.assertEqual(records["654321"]["category"], "qdii")
        self.assertEqual(records["234567"]["category"], "bond")

    def test_disclosed_csv_sorts_nav_and_never_treats_accumulated_as_total_return(self):
        source = StringIO("date,unit_nav,accumulated_nav\n2025-01-06,1.4,3.0\n2025-01-03,1.5,3.1\n")
        data = parse_disclosed_csv(source, "000001", "合成测试基金", "测试披露", "https://example.test/",
                                   retrieved_at=self.retrieval)
        self.assertEqual(data["return_basis"], "unavailable")
        self.assertEqual(data["rows"][0]["date"], "2025-01-03")
        self.assertEqual(data["rows"][0]["accumulated_nav"], 3.1)
        self.assertIsNone(data["rows"][0]["return_index"])
        invalid = StringIO("date,unit_nav\n2025-01-06,NaN\n")
        with self.assertRaisesRegex(ValueError, "净值或总回报"):
            parse_disclosed_csv(invalid, "000001", "合成测试基金", "测试披露", "https://example.test/",
                                retrieved_at=self.retrieval)

    @patch("stock_analysis.funds.current_catalog", side_effect=URLError("directory unavailable"))
    @patch("stock_analysis.funds.download")
    def test_market_provider_only_reads_validated_code_and_handles_directory_outage(self, download, _catalog):
        with self.assertRaisesRegex(ValueError, "六位"):
            load_fund("sh000001")
        download.assert_not_called()
        download.return_value = history(self.rows)
        data = load_fund("000001")
        self.assertEqual(data["category"], "unknown")
        self.assertIsNone(data["valuation_frequency"])
        download.assert_called_once_with("https://fund.eastmoney.com/pingzhongdata/000001.js")

    def test_concurrent_fund_queries_share_only_the_inflight_request(self):
        started, waiter, finish = Event(), Event(), Event()

        class ObservedFuture(Future):
            def result(self, timeout=None):
                waiter.set()
                return super().result(timeout)

        def operation():
            started.set()
            if not finish.wait(3):
                raise TimeoutError("test did not release the operation")
            return {"source": "synthetic"}

        with patch("stock_analysis.funds.Future", ObservedFuture), ThreadPoolExecutor(2) as pool:
            first = pool.submit(coalesce, ("history", "000001"), operation)
            self.assertTrue(started.wait(3))
            second = pool.submit(coalesce, ("history", "000001"), lambda: self.fail("double fetch"))
            self.assertTrue(waiter.wait(3))
            finish.set()
            self.assertIs(first.result(3), second.result(3))
        with self.assertRaises(URLError):
            coalesce(("history", "000001"), lambda: (_ for _ in ()).throw(URLError("temporary")))
        self.assertEqual(coalesce(("history", "000001"), lambda: "fresh"), "fresh")
