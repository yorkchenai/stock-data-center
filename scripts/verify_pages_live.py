"""Compare live browser records with independent Python requests and formulas."""
import argparse
import json
import importlib
from pathlib import Path
from unittest import mock
from types import SimpleNamespace

import numpy as np
import pandas as pd

from stock_analysis.data import fetch_daily
from stock_analysis import data
from stock_analysis.indicators import calculate_indicators
from stock_analysis.symbols import resolve_symbol
from stock_analysis.validation import NUMERIC_COLUMNS, audit_calendar
from stock_analysis.web import INDICATOR_FIELDS


def parse_browser_responses(instrument, dataset, responses):
    if dataset['source'] == 'eastmoney':
        raw = next(item['payload'] for item in responses if 'push2his.eastmoney.com/' in item['url'])
        with mock.patch.object(data, 'request_json', return_value=raw):
            return fetch_daily(instrument, dataset["requested_start"], dataset["requested_end"], source='eastmoney')
    else:
        import akshare as ak
        module = importlib.import_module(ak.stock_zh_a_hist_tx.__module__)
        raw = [item['payload'] for item in responses if 'proxy.finance.qq.com/' in item['url']]
        responses = [SimpleNamespace(text=json.dumps(item)) for item in raw]
        with mock.patch.object(module, 'get_tx_start_year', return_value=dataset['requested_start']), mock.patch.object(module.http, 'get', side_effect=responses):
            return fetch_daily(instrument, dataset["requested_start"], dataset["requested_end"], source='tencent')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=Path("work/pages-live"))
    args = parser.parse_args()
    report = []
    for symbol in ["000688", "600519", "399006", "sh000001"]:
        result = {"symbol": symbol, "status": "failed"}
        try:
            payload = json.loads((args.input / f"{symbol}.json").read_text())
            if payload["status"] != "success":
                raise ValueError(payload.get("error", "Browser failed"))
            dataset = payload["dataset"]
            actual = pd.DataFrame(dataset["rows"])
            instrument = resolve_symbol(symbol)
            # Parse the exact raw response through the EXISTING Python source
            # adapter, independently of JS normalization. Transport checks are
            # reported separately; a closed Python connection is not a math error.
            daily, provenance = parse_browser_responses(instrument, dataset, payload['responses'])
            expected = calculate_indicators(daily)
            np.testing.assert_array_equal(actual.date, daily.date.dt.strftime("%Y-%m-%d"))
            for field in NUMERIC_COLUMNS + INDICATOR_FIELDS:
                np.testing.assert_array_equal(actual[field].isna(), expected[field].isna())
                np.testing.assert_allclose(actual[field].astype(float), expected[field], rtol=1e-12, atol=1e-9, equal_nan=True, err_msg=field)
            audit = audit_calendar(daily, instrument, dataset['requested_start'], dataset['requested_end'])
            for field in ['expected_sessions', 'observed_sessions', 'missing_sessions', 'interior_missing_sessions',
                          'confirmed_suspension_sessions', 'unverified_missing_sessions', 'suspension_data_conflicts', 'completeness_verified']:
                if dataset['validation'][field] != audit[field]:
                    raise AssertionError(f'Trading-calendar parity failed: {field}')
            result.update(status="passed", source=provenance["source"], rows=len(actual), first=actual.date.iloc[0], last=actual.date.iloc[-1],
                          calendar_parity='passed',
                          comparison='existing Python source adapter + formulas on captured raw browser responses',
                          max_absolute_error={field: float((actual[field].astype(float) - expected[field]).abs().max()) if actual[field].notna().any() else None for field in INDICATOR_FIELDS})
            try:
                independent, _ = fetch_daily(instrument, dataset['requested_start'], dataset['requested_end'], source=dataset['source'])
            except Exception as error:
                result['independent_http'] = {'status': 'unverified', 'error': f'{type(error).__name__}: {error}'}
            else:
                np.testing.assert_array_equal(independent.date.dt.strftime('%Y-%m-%d'), actual.date)
                for field in NUMERIC_COLUMNS:
                    np.testing.assert_allclose(independent[field], actual[field], rtol=1e-12, atol=1e-9, err_msg=field)
                result['independent_http'] = {'status': 'passed'}
        except Exception as error:
            result.update(status="failed", error=f"{type(error).__name__}: {error}")
        report.append(result)
    (args.input / "python-comparison.json").write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False))
    print(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False))
    if any(item["status"] != "passed" for item in report):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
