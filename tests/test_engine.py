"""Offline tests. Synthetic sequences below are numerical fixtures, not market data."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock
import json
import unittest

import numpy as np
import pandas as pd
from pandas.testing import assert_frame_equal
import matplotlib.image as mpimg

from stock_analysis import data
from stock_analysis.charts import CHART_FILES
from stock_analysis.indicators import calculate_indicators, rsi_wilder
from stock_analysis.pipeline import ANALYSIS_LAYERS, run_analysis
from stock_analysis.symbols import resolve_symbol
from stock_analysis.validation import audit_calendar, normalize_daily

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "results/000688_daily.csv"


def numerical_fixture(close):
    """Artificial input used only to check mathematical identities."""
    close = np.asarray(close, dtype=float)
    return pd.DataFrame({"date": pd.bdate_range("2025-01-06", periods=len(close)),
                         "open": close, "close": close, "high": close + 1,
                         "low": close - 1, "volume_lots": np.arange(len(close)) + 1,
                         "turnover_cny": 10000.0})


class SymbolTests(TestCase):
    def test_markets_and_indices(self):
        cases = [("600519", "sh", "stock"), ("601318", "sh", "stock"),
                 ("603259", "sh", "stock"), ("605499", "sh", "stock"),
                 ("sz000001", "sz", "stock"), ("002594", "sz", "stock"),
                 ("300750", "sz", "stock"), ("301269", "sz", "stock"),
                 ("688981", "sh", "stock"), ("000688", "sh", "index"),
                 ("sh000001", "sh", "index"), ("sh000010", "sh", "index"), ("000300", "sh", "index"),
                 ("399001", "sz", "index"), ("399006", "sz", "index")]
        for value, market, kind in cases:
            with self.subTest(value=value):
                result = resolve_symbol(value)
                self.assertEqual((result.market, result.kind), (market, kind))
                self.assertEqual(result.secid, ("1." if market == "sh" else "0.") + result.code)

    def test_ambiguous_code_requires_context(self):
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            resolve_symbol("000001")
        self.assertEqual(resolve_symbol("000001", "stock").symbol, "sz000001")
        self.assertEqual(resolve_symbol("000001", "index").symbol, "sh000001")
        self.assertNotEqual(resolve_symbol("000001", "stock").key, resolve_symbol("000001", "index").key)

    def test_reject_unsupported_or_mismatched_code(self):
        for value in ["1", "sh600519/../../x", "sz600519", "sh300750", "bj920001", "510300", "830001"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                resolve_symbol(value)


class CalculationTests(TestCase):
    def test_real_history_regression(self):
        actual = calculate_indicators(pd.read_csv(BASELINE))
        old = pd.read_csv(ROOT / "results/charts/000688_indicators.csv")
        for name in ["MA5", "MA10", "MA20", "MA60", "VMA5", "VMA10", "DIF", "DEA", "MACD_hist", "RSI6", "RSI14", "RSI24", "+DI", "-DI", "ADX14"]:
            with self.subTest(indicator=name):
                np.testing.assert_allclose(actual[name], old[name], atol=0.00000051, rtol=0, equal_nan=True)

    def test_known_wilder_rsi_example(self):
        close = pd.Series([44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10,
                           45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00])
        result = rsi_wilder(close, 14)
        self.assertTrue(result.iloc[:14].isna().all())
        self.assertAlmostEqual(result.iloc[14], 70.464135021097, places=10)
        self.assertAlmostEqual(result.iloc[15], 66.249618553555, places=10)

    def test_manual_ema_and_macd_seeds(self):
        result = calculate_indicators(numerical_fixture([10, 12, 11]))
        self.assertAlmostEqual(result.EMA12.iloc[1], 10 + 4 / 13)
        self.assertAlmostEqual(result.EMA26.iloc[1], 10 + 4 / 27)
        dif = 4 / 13 - 4 / 27
        self.assertAlmostEqual(result.DEA.iloc[1], dif / 5)
        self.assertAlmostEqual(result.MACD_hist.iloc[1], 2 * dif * 4 / 5)
        self.assertAlmostEqual(result.change_pct.iloc[1], 20)
        self.assertTrue(pd.isna(result.change_pct.iloc[0]))

    def test_hand_computed_trend_and_warmup(self):
        result = calculate_indicators(numerical_fixture(np.arange(10, 80)))
        self.assertAlmostEqual(result.MA5.iloc[4], 12)
        self.assertAlmostEqual(result.VOL5.iloc[4], 3)
        self.assertAlmostEqual(result.VOL10.iloc[9], 5.5)
        for period in [6, 12, 14, 24]:
            self.assertTrue(result[f"RSI{period}"].iloc[:period].isna().all())
            np.testing.assert_allclose(result[f"RSI{period}"].iloc[period:], 100)
        self.assertTrue(result["+DI"].iloc[:14].isna().all())
        np.testing.assert_allclose(result["+DI"].iloc[14:], 50)
        np.testing.assert_allclose(result["-DI"].iloc[14:], 0)
        self.assertTrue(result.ADX14.iloc[:27].isna().all())
        np.testing.assert_allclose(result.ADX14.iloc[27:], 100)
        for period in [5, 10, 20, 60]:
            self.assertEqual(result[f"MA{period}"].first_valid_index(), period - 1)

    def test_adx_reversal_golden_values(self):
        # Ten +1 moves and four -1 moves seed DM sums 10 and 4, TR sum 28.
        # Golden values use exact rational Wilder arithmetic for the next 13 moves.
        moves = [1] * 10 + [-1] * 4 + [1, -1, -1, 1, 1, -1, 1, -1, -1, 1, 1, 1, -1]
        close = np.r_[100, 100 + np.cumsum(moves)]
        result = calculate_indicators(numerical_fixture(close))
        self.assertAlmostEqual(result["+DI"].iloc[14], 1000 / 28)
        self.assertAlmostEqual(result["-DI"].iloc[14], 400 / 28)
        self.assertAlmostEqual(result["+DI"].iloc[27], 30.447816818474646)
        self.assertAlmostEqual(result["-DI"].iloc[27], 19.552183181525354)
        self.assertAlmostEqual(result.ADX14.iloc[27], 29.765251817094178)

    def test_short_flat_and_falling_sequences(self):
        for length in [1, 6, 14, 27, 28, 60]:
            result = calculate_indicators(numerical_fixture(np.full(length, 10)))
            self.assertFalse(np.isinf(result.select_dtypes("number")).any().any())
            if length > 14:
                np.testing.assert_allclose(result.RSI14.iloc[14:], 50)
            if length > 27:
                np.testing.assert_allclose(result.ADX14.iloc[27:], 0)
        falling = calculate_indicators(numerical_fixture(np.arange(100, 30, -1)))
        np.testing.assert_allclose(falling.RSI12.iloc[12:], 0)
        np.testing.assert_allclose(falling["-DI"].iloc[14:], 50)
        flat = numerical_fixture(np.full(60, 10))
        flat["high"] = flat["low"] = flat.close
        result = calculate_indicators(flat)
        np.testing.assert_allclose(result[["+DI", "-DI"]].iloc[14:], 0)
        np.testing.assert_allclose(result.ADX14.iloc[27:], 0)

    def test_future_rows_do_not_change_past(self):
        frame = pd.read_csv(BASELINE)
        short = calculate_indicators(frame.head(80))
        long = calculate_indicators(frame)
        assert_frame_equal(short, long.head(80))


class ValidationTests(TestCase):
    def test_invalid_inputs_are_rejected(self):
        baseline = numerical_fixture([10, 11, 12])
        for field, value in [("close", np.nan), ("volume_lots", np.inf), ("turnover_cny", None),
                             ("volume_lots", -1), ("turnover_cny", -1), ("open", 0), ("low", 20)]:
            bad = baseline.copy().astype({"volume_lots": float})
            bad.loc[1, field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                normalize_daily(bad)
        bad = baseline.copy()
        bad.loc[1, "date"] = bad.date.iloc[0]
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            normalize_daily(bad)
        with self.assertRaises(ValueError):
            normalize_daily(baseline.drop(columns="turnover_cny"))

    def test_sorting_and_non_mutation(self):
        original = numerical_fixture([10, 11, 12]).iloc[::-1].copy()
        saved = original.copy(deep=True)
        self.assertTrue(normalize_daily(original).date.is_monotonic_increasing)
        assert_frame_equal(original, saved)

    def test_calendar_holiday_boundary_and_stock_suspension(self):
        frame = normalize_daily(pd.read_csv(BASELINE))
        subset = frame[frame.date.between("2025-01-01", "2025-01-10")].reset_index(drop=True)
        index = resolve_symbol("000688")
        complete = audit_calendar(subset, index, "2025-01-01", "2025-01-10")
        self.assertTrue(complete["completeness_verified"])
        gap = audit_calendar(subset.drop(index=2), resolve_symbol("600519"), "2025-01-01", "2025-01-10")
        self.assertFalse(gap["completeness_verified"])
        self.assertEqual(len(gap["interior_missing_sessions"]), 1)
        # Even with all session rows, stock-specific completeness is unproven.
        self.assertFalse(audit_calendar(subset, resolve_symbol("600519"), "2025-01-01", "2025-01-10")["completeness_verified"])


class ProviderTests(TestCase):
    def test_eastmoney_mapping(self):
        payload = {"data": {"code": "600519", "klines": ["2025-01-06,10,11,12,9,123,45678,0,0"]}}
        with mock.patch.object(data, "request_json", return_value=payload) as request:
            frame = normalize_daily(data.eastmoney(resolve_symbol("600519"), "2025-01-01", "2025-01-10"))
        self.assertIn("secid=1.600519", request.call_args.args[0])
        self.assertIn("fqt=0", request.call_args.args[0])
        self.assertEqual(frame.volume_lots.iloc[0], 123)
        self.assertEqual(frame.turnover_cny.iloc[0], 45678)

    def test_eastmoney_index_rejects_matching_code_in_wrong_market(self):
        instrument = resolve_symbol("sh000991", kind="index")
        query = {"data": {"code": "000991", "market": 0, "klines": ["2025-01-06,10,11,12,9,123,45678"]}}
        with mock.patch.object(data, "request_json", return_value=query):
            with self.assertRaisesRegex(ValueError, "different instrument"):
                data.eastmoney(instrument, "2025-01-01", "2025-01-10")

    def test_tencent_units_and_unadjusted_parameters(self):
        import akshare as ak
        frame = numerical_fixture([10, 11]).rename(columns={"volume_lots": "volume", "turnover_cny": "amount"})
        frame["volume"] = 12300
        for symbol in ["sz000001", "000688", "300750", "688981"]:
            with self.subTest(symbol=symbol), mock.patch.object(ak, "stock_zh_a_hist_tx", return_value=frame) as fetch:
                instrument = resolve_symbol(symbol)
                result = data.tencent(instrument, "2025-01-01", "2025-01-10")
                self.assertEqual(result.volume_lots.iloc[0], 123)
                self.assertEqual(result.turnover_cny.iloc[0], 10000)
                fetch.assert_called_once_with(symbol=instrument.symbol, start_date="20250101", end_date="20250110", adjust="")

    def test_fallback_after_network_or_data_failure(self):
        for primary in [RuntimeError("network blocked"), numerical_fixture([10]).drop(columns="turnover_cny")]:
            kwargs = {"side_effect": primary} if isinstance(primary, Exception) else {"return_value": primary}
            with mock.patch.object(data, "eastmoney", **kwargs), mock.patch.object(data, "tencent", return_value=numerical_fixture([10, 11])):
                frame, report = data.fetch_daily(resolve_symbol("600519"), "2025-01-01", "2025-01-10")
                self.assertEqual(len(frame), 2)
                self.assertEqual(report["source"], "tencent")
                self.assertEqual(report["attempts"][0]["status"], "failed")

    def test_both_fail_without_inventing_rows(self):
        with mock.patch.object(data, "eastmoney", side_effect=OSError("blocked")), mock.patch.object(data, "tencent", side_effect=OSError("blocked")):
            with self.assertRaises(data.FetchError) as error:
                data.fetch_daily(resolve_symbol("600519"), "2025-01-01", "2025-01-10")
            self.assertEqual(len(error.exception.attempts), 2)


class PipelineTests(TestCase):
    def test_real_data_outputs_charts_json_and_isolation(self):
        with TemporaryDirectory() as directory:
            _, first = run_analysis(resolve_symbol("000688"), "2026-01-01", "2026-11-20", directory, BASELINE)
            path = Path(first["output_dir"])
            original = (path / "indicators.csv").read_bytes()
            _, second = run_analysis(resolve_symbol("000688"), "2026-01-01", "2026-11-20", directory, BASELINE)
            self.assertNotEqual(first["output_dir"], second["output_dir"])
            self.assertEqual((path / "indicators.csv").read_bytes(), original)
            daily = pd.read_csv(path / "daily.csv")
            values = json.loads((path / "indicators.json").read_text(), parse_constant=lambda x: self.fail(x))
            self.assertEqual(len(values), len(daily))
            self.assertIsNone(values[0]["RSI12"])
            self.assertEqual(values[-1]["close"], daily.close.iloc[-1])
            self.assertEqual(first["analysis_layers"], ANALYSIS_LAYERS)
            for name in CHART_FILES:
                image = mpimg.imread(path / "charts" / name)
                self.assertGreater(image.shape[0], 400)
                self.assertGreater(image.std(), 0.01)

    def test_failure_report_and_input_preservation(self):
        with TemporaryDirectory() as directory:
            before = BASELINE.read_bytes()
            with mock.patch("stock_analysis.pipeline.fetch_daily", side_effect=data.FetchError([{"source": "eastmoney", "status": "failed"}])):
                with self.assertRaises(data.FetchError):
                    run_analysis(resolve_symbol("600519"), "2025-01-01", "2025-01-10", directory)
            reports = list(Path(directory).rglob("report.json"))
            self.assertEqual(len(reports), 1)
            self.assertEqual(json.loads(reports[0].read_text())["status"], "failed")
            self.assertEqual(BASELINE.read_bytes(), before)
            self.assertFalse(list(Path(directory).rglob("daily.csv")))


if __name__ == "__main__":
    unittest.main()
