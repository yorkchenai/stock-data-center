from datetime import date, datetime, timezone
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from stock_analysis.fund_rates import HISTORY_URL, fetch_rate_history, load_chinabond_rates, parse_yield_history
from stock_analysis.funds import attach_benchmark_data, official_benchmarks


def yield_table(*rows):
    body = "".join(f"<tr><td>{curve}</td><td>{day}</td><td>{value}</td></tr>"
                   for curve, day, value in rows)
    return f"<table><tr><td>曲线名称</td><td>日期</td><td>3&nbsp;月</td></tr>{body}</table>"


class FundRatesTest(unittest.TestCase):
    def test_only_three_month_sovereign_quotes_are_converted_to_decimal(self):
        html = yield_table(("中债商业银行普通债收益率曲线(AAA)", "2025-01-03", "9.99"),
                           ("中债国债收益率曲线", "2025-01-03", "1.4500"),
                           ("中债国债收益率曲线", "2025-01-02", "--"))
        rates = parse_yield_history(html, date(2025, 1, 1), date(2025, 1, 3))
        self.assertEqual([row["date"] for row in rates], ["2025-01-03"])
        self.assertAlmostEqual(rates[0]["annual_rate"], .0145)

    def test_rejects_duplicate_and_out_of_window_dates(self):
        for observations in [
            [("中债国债收益率曲线", "2025-01-03", "1.5")] * 2,
            [("中债国债收益率曲线", "2025-01-07", "1.5")],
        ]:
            with self.subTest(observations=observations):
                with self.assertRaisesRegex(ValueError, "重复或超出"):
                    parse_yield_history(yield_table(*observations), date(2025, 1, 1), date(2025, 1, 3))

    def test_batches_are_bounded_and_actual_coverage_is_used(self):
        calls = []

        def download(url):
            params = parse_qs(urlsplit(url).query)
            first, last = params["startDate"][0], params["endDate"][0]
            calls.append((first,last))
            return yield_table(("中债国债收益率曲线", first, "1.50"))

        rates = load_chinabond_rates(date(2024, 1, 11), date(2025, 1, 13), download,
                                    datetime(2025, 1, 14, tzinfo=timezone.utc))
        self.assertEqual(calls, [("2024-01-01","2024-12-25"),("2024-12-26","2025-01-13")])
        self.assertEqual(rates["effective_from"], "2024-01-11")
        self.assertEqual(rates["effective_to"], "2024-12-26")
        self.assertEqual(rates["rows"][0]["annual_rate"], .015)
        self.assertEqual(rates["convention"], "simple_act_365f")

    def test_official_mirror_is_used_for_timeout_without_retrying_a_refusal(self):
        with patch("stock_analysis.funds.download", side_effect=[TimeoutError(), "quote"]) as download:
            self.assertEqual(fetch_rate_history(HISTORY_URL), "quote")
            self.assertIn("indices.chinabond.com.cn", download.call_args.args[0])
        with patch("stock_analysis.funds.download", side_effect=HTTPError(HISTORY_URL, 403, "denied", None, None)) as download:
            with self.assertRaises(HTTPError):
                fetch_rate_history(HISTORY_URL)
            download.assert_called_once()

    def test_audited_definitions_and_yearly_periods_are_not_overwritten_by_component_import(self):
        trusted = official_benchmarks()
        chinaamc = trusted["000001"]
        self.assertEqual(chinaamc["regimes"][0]["effective_to"], "2026-07-26")
        self.assertEqual([i["weight"] for i in chinaamc["regimes"][1]["components"]], [.7,.3])
        self.assertEqual(trusted["110017"]["regimes"][0]["components"][0]["basis"], "full_price")
        self.assertEqual(len(trusted["000311"]["disclosed_periods"]), 3)
        fund = {"code":"000001","benchmark":chinaamc}
        self.assertEqual(attach_benchmark_data(fund, {"code":"000001","series":[]})["benchmark"]["regimes"], chinaamc["regimes"])
        with self.assertRaisesRegex(ValueError, "不匹配"):
            attach_benchmark_data(fund, {"code":"000311","series":[]})
