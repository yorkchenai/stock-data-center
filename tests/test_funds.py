from datetime import datetime, timezone
from io import StringIO
import json
import unittest
from unittest.mock import patch
from urllib.error import URLError

from stock_analysis.funds import assignment, load_fund, nav_event, parse_catalog, parse_disclosed_csv, parse_history


def epoch(day):
    return datetime.fromisoformat(day + "T00:00:00+08:00").timestamp() * 1000


def history(rows, code="000001", name="合成测试基金"):
    fields = {"fS_code": code, "fS_name": name, "Data_netWorthTrend": rows,
              "Data_ACWorthTrend": [[row["x"], 10] for row in rows]}
    return "".join(f"var {key} = {json.dumps(value)};\n" for key, value in fields.items())


class FundProviderTests(unittest.TestCase):
    def setUp(self):
        self.retrieval = datetime(2025, 1, 9, tzinfo=timezone.utc)
        self.rows = [
            {"x": epoch("2025-01-02"), "y": 1.5, "unitMoney": "", "equityReturn": 0},
            {"x": epoch("2025-01-03"), "y": 1.45, "unitMoney": "每10份派现金1.0元", "equityReturn": 3.33},
            {"x": epoch("2025-01-06"), "y": .75, "unitMoney": "每份折算2份", "equityReturn": 3.45},
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
        self.assertIsNone(nav_event(None))
        self.assertIsNone(nav_event("每0份派现金2.0元"))

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
        ]) + ';')
        self.assertEqual(set(records), {"000001", "123456", "654321"})
        self.assertEqual(records["000001"]["category"], "index")
        self.assertEqual(records["123456"]["category"], "money")
        self.assertEqual(records["654321"]["category"], "qdii")

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
