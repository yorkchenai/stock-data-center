"""Compare live browser records with independent Python requests and formulas."""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from stock_analysis.data import fetch_daily
from stock_analysis.indicators import calculate_indicators
from stock_analysis.symbols import resolve_symbol
from stock_analysis.validation import NUMERIC_COLUMNS
from stock_analysis.web import INDICATOR_FIELDS


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
            daily, provenance = fetch_daily(resolve_symbol(symbol), dataset["requested_start"], dataset["requested_end"], source=dataset["source"])
            expected = calculate_indicators(daily)
            np.testing.assert_array_equal(actual.date, daily.date.dt.strftime("%Y-%m-%d"))
            for field in NUMERIC_COLUMNS + INDICATOR_FIELDS:
                np.testing.assert_array_equal(actual[field].isna(), expected[field].isna())
                np.testing.assert_allclose(actual[field].astype(float), expected[field], rtol=1e-12, atol=1e-9, equal_nan=True, err_msg=field)
            result.update(status="passed", source=provenance["source"], rows=len(actual), first=actual.date.iloc[0], last=actual.date.iloc[-1],
                          max_absolute_error={field: float((actual[field].astype(float) - expected[field]).abs().max()) if actual[field].notna().any() else None for field in INDICATOR_FIELDS})
        except Exception as error:
            result["error"] = f"{type(error).__name__}: {error}"
        report.append(result)
    (args.input / "python-comparison.json").write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False))
    print(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False))
    if any(item["status"] != "passed" for item in report):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
