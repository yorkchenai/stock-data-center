import json
import shutil
import subprocess
import unittest
from urllib.error import HTTPError, URLError

from stock_analysis.fund_benchmark_formula import formula_key, parse_formula
from stock_analysis.fund_benchmark_identification import identify
from stock_analysis.fund_benchmark_sources import PROFILES, parse_profile, read_candidate
from stock_analysis.funds import benchmark_metadata, fund_benchmark

INDEX = "沪深300指数收益率"
OTHER = "中证500指数收益率"
SOURCE = "https://example.com/fund-contract.pdf"
AS_OF = "2026-11-23"


def profile(source, code, formula, status="found"):
    return {"source": source, "fund_code": code, "source_url": PROFILES[source].format(code),
            "status": status, "formula": formula}


def statute(start, end, formula, **overrides):
    return {"effective_from": start, "effective_to": end, "formula": formula,
            "verification": "official_verified", "source_url": SOURCE, **overrides}


def evidence(*regimes):
    return {"123456": {"share_codes": ["123456"], "share_source_url": SOURCE, "regimes": regimes}}


class BenchmarkDisplayTest(unittest.TestCase):
    def test_reviewed_disclosures_are_available_without_computable_points(self):
        self.assertIsNone(benchmark_metadata("110022", AS_OF)["benchmark_disclosure"])
        for code, effective, weight in [("006751", "2026-07-27", "65%"), ("003095", "2026-09-21", "90%")]:
            with self.subTest(code=code):
                fields = benchmark_metadata(code, AS_OF)
                self.assertIsNone(fields["benchmark"])
                disclosure = fields["benchmark_disclosure"]
                self.assertIn(weight, disclosure["formula"])
                self.assertEqual(disclosure["effective_from"], effective)
                self.assertTrue(disclosure["source_url"].startswith("https://"))
                old = benchmark_metadata(code, "2026-07-01")["benchmark_disclosure"]
                self.assertTrue(old is None or old["effective_from"] < effective)


class BenchmarkSourcesTest(unittest.TestCase):
    def test_separates_official_label_from_tracking_and_fund_identity(self):
        body = """<table>
        <tr><td>基金代码</td><td>123456</td><td>基金类型</td><td>指数型</td></tr>
        <tr><th>跟踪标的</th><td>测试跟踪指数</td></tr>
        <tr><th>第三方分类基准</th><td>勿用</td></tr>
        <tr><th>基金比较基准：</th><td>中证500指数收益率</td></tr></table>"""
        candidate = parse_profile("sina", "123456", body, AS_OF)
        self.assertEqual(candidate.status, "found")
        self.assertEqual(candidate.formula, OTHER)
        self.assertEqual(candidate.tracking_target, "测试跟踪指数")
        bad = body.replace("</table>", "<tr><th>交易代码</th><td>654321</td></tr></table>")
        self.assertEqual(parse_profile("sina", "654321", bad, AS_OF).status, "identity_unverified")
        self.assertEqual(parse_profile("sina", "123456", body.replace(OTHER, "无"), AS_OF).status,
                         "field_missing")
        conflict = body.replace("</table>", "<tr><th>基金比较基准</th><td>沪深300指数收益率</td></tr></table>")
        self.assertEqual(parse_profile("sina", "123456", conflict, AS_OF).status, "field_conflict")

    def test_invalid_share_and_restriction_are_explicit(self):
        def rejected(request, timeout):
            raise HTTPError(request.full_url, 429, "rate limit", None, None)

        def unavailable(request, timeout):
            raise URLError("offline")

        self.assertEqual(read_candidate("sina", "123456", http=rejected).status, "access_restricted")
        self.assertEqual(read_candidate("sina", "123456", http=unavailable).status, "network_error")
        with self.assertRaises(ValueError):
            read_candidate("sina", "123456,654321")


class BenchmarkFormulaTest(unittest.TestCase):
    def test_weights_return_suffix_and_order_are_normalized(self):
        first = "本基金的业绩比较基准为：" + INDEX + "×６０％＋中债综合指数（全价）收益率×40%。"
        second = "40%*中债综合指数(全价)+60%*" + INDEX
        parsed = parse_formula(first)
        self.assertEqual(parsed["original"], first)
        self.assertEqual(formula_key(parsed), formula_key(parse_formula(second)))
        bond = parsed["components"][1]
        self.assertEqual((bond["weight"], bond["mapping"]["id"], bond["mapping"]["basis"]),
                         (.4, "CBA00203", "full_price"))

    def test_preserves_disclosed_variants_without_guessing(self):
        currency = parse_formula("中证港股通综合指数（人民币）收益率")["components"][0]
        self.assertEqual(currency["mapping"]["id"], "930933")
        self.assertEqual(parse_formula("中证港股通综合指数收益率")["components"][0]["mapping"]["status"],
                         "ambiguous")
        variant = parse_formula("沪深300全收益指数收益率")["components"][0]
        self.assertEqual(variant["basis"], "total_return")
        self.assertEqual(variant["mapping"]["status"], "unmapped")
        oil = parse_formula("标普高盛原油商品指数(S&P GSCI Crude Oil Index ER)收益率")["components"][0]
        self.assertEqual(oil["basis"], "excess_return")
        self.assertIn("IndexER", oil["name"])
        fx = parse_formula("经人民币汇率调整的标普500净总收益指数收益率")["components"][0]
        self.assertEqual(fx["fx"], {"target_currency": "CNY", "method": "unspecified"})
        self.assertEqual(fx["basis"], "net_total_return")

    def test_cash_amounts_and_tax_timing_remain_distinct(self):
        fixed = parse_formula(INDEX + "*95%+1%（指年收益率，评价时按期间折算）")["components"][1]
        self.assertEqual((fixed["type"], fixed["rate"], fixed["rate_basis"]), ("fixed_rate", .01, "annual"))
        deposit = parse_formula("该封闭期起始日的两年期定期存款利率(税后)+1%")
        self.assertEqual(deposit["components"][0]["timing"], "closed_period_start")
        self.assertEqual(deposit["components"][0]["tax_basis"], "after_tax")
        self.assertNotEqual(formula_key(deposit),
                            formula_key(parse_formula("两年期定期存款利率(税后)+1%")))
        self.assertIsNone(deposit["components"][1]["rate_basis"])

    def test_rejects_unknown_syntax_missing_weights_and_bad_parentheses(self):
        for formula, reason in [
            (INDEX + "*X+" + OTHER + "*(1-X)", "variable_weights"),
            (INDEX + "*60%+" + OTHER + "*40", "missing_percentage_marker"),
            (INDEX + "*60%+" + OTHER + "*30%", "weights_do_not_sum_to_one"),
            (INDEX + "+" + OTHER, "unspecified_weight"),
            ("中证港股通综合指数(人民币", "unbalanced_parentheses"),
            ("请参阅最新基金合同", "unsupported_term"),
        ]:
            with self.subTest(formula=formula):
                self.assertEqual(parse_formula(formula)["reason"], reason)


class BenchmarkIdentificationTest(unittest.TestCase):
    def test_unverified_sources_cannot_promote_a_definition(self):
        for first, second, grade in [(INDEX, INDEX, "B"), (INDEX, OTHER, "C"), (None, None, "D")]:
            with self.subTest(grade=grade):
                candidates = [profile("eastmoney", "123456", first), profile("sina", "123456", second)]
                result = identify("123456", candidates, AS_OF, evidence={})
                self.assertEqual(result["grade"], grade)
                self.assertIsNone(result["benchmark"])
                self.assertEqual(result["history_points_status"], "not_requested")
        with self.assertRaises(ValueError):
            identify("123456", [profile("sina", "000001", INDEX)], AS_OF)

    def test_as_of_filters_future_announcement_and_marks_stale_after_effective_date(self):
        old = statute("2020-01-01", "2026-11-29", INDEX,
                      method="single_index", method_source_url=SOURCE)
        new = statute("2026-11-30", None, OTHER, announced_on="2026-10-31",
                      change_confirmed=True, method="single_index", method_source_url=SOURCE)
        sources = [profile("eastmoney", "123456", OTHER), profile("sina", "123456", INDEX)]
        early = identify("123456", sources, "2026-10-25", evidence(old, new))
        self.assertEqual(len(early["regimes"]), 1)
        self.assertIsNone(early["benchmark"]["regimes"][0]["effective_to"])
        pending = identify("123456", sources, AS_OF, evidence(old, new))
        self.assertEqual(pending["candidates"][0]["official_comparison"], "premature")
        self.assertEqual(pending["effective_change_count"], 0)
        latest = identify("123456", sources, "2026-11-30", evidence(old, new))
        self.assertEqual(latest["candidates"][1]["official_comparison"], "stale")
        self.assertEqual(len(latest["benchmark"]["regimes"]), 2)

    def test_explicit_none_unknown_gap_and_incompatible_method(self):
        no_benchmark = statute("2020-01-01", "2021-12-31", None, verification="official_none")
        approved = statute("2023-01-01", None, INDEX, method="single_index", method_source_url=SOURCE)
        reviewed = evidence(no_benchmark, approved)
        self.assertEqual(identify("123456", [], "2021-01-02", reviewed)["official_status"], "official_none")
        self.assertEqual(identify("123456", [], "2022-01-02", reviewed)["official_status"], "historical_gap")
        self.assertEqual(identify("123456", [], AS_OF, reviewed)["benchmark"]["regimes"][0]["method"], "none")
        missing_method = statute("2025-01-01", None, INDEX)
        self.assertIsNone(identify("123456", [], AS_OF, evidence(missing_method))["benchmark"])
        with self.assertRaises(ValueError):
            identify("123456", [], AS_OF, evidence(approved, missing_method))

    @unittest.skipUnless(shutil.which("node"), "Node is required for the existing engine contract check")
    def test_real_disclosure_with_synthetic_levels_in_existing_engine(self):
        definition = fund_benchmark("024808", AS_OF)
        self.assertEqual([row["method"] for row in definition["regimes"]], ["unverified", "daily_weighted"])
        self.assertEqual([row["id"] for row in definition["regimes"][1]["components"]],
                         ["H30355", "930933", "CBA00201"])
        self.assertIsNone(fund_benchmark("024808", "2026-07-24"))
        self.assertIsNone(fund_benchmark("519674", AS_OF))
        script = """
        import assert from 'node:assert/strict';
        import { readFileSync } from 'node:fs';
        import { normalizeBenchmark, compareBenchmark } from './web/funds/benchmark.mjs';
        const raw = JSON.parse(readFileSync(0, 'utf8'));
        const days = ['2026-07-24','2026-07-27','2026-07-28'];
        const rows = days.map(date => ({date}));
        const empty = normalizeBenchmark(raw, days.at(-1));
        assert.equal(compareBenchmark(empty, rows).value, null);
        raw.series = raw.regimes[1].components.map((item, i) => ({
          id:item.id, basis:item.basis, source:'Synthetic contract test',
          rows:days.map((date,j) => ({date, value:100 * (1 + (i + 1) / 100) ** j}))
        }));
        const result = compareBenchmark(normalizeBenchmark(raw, days.at(-1)), rows);
        assert.equal(result.status, 'complete');
        assert.ok(Math.abs(result.value - ((1 + .7*.01 + .1*.02 + .2*.03) ** 2 - 1)) < 1e-12);
        const earlier = ['2026-07-23', ...days].map(date => ({date}));
        assert.equal(compareBenchmark(normalizeBenchmark(raw, days.at(-1)), earlier).value, null);
        """
        result = subprocess.run(["node", "--input-type=module", "-e", script],
                                input=json.dumps(definition), text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
