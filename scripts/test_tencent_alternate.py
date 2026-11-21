"""One-shot Tencent alternate-index API acceptance test; production data untouched."""
import json
from datetime import datetime, timezone
from pathlib import Path
import akshare as ak
import pandas as pd

report = {"source": "AKShare index_zh_daily_tx (Tencent)", "symbol": "sh000688",
          "tested_at_utc": datetime.now(timezone.utc).isoformat(), "status": "failed"}
try:
    frame = ak.index_zh_daily_tx(symbol="sh000688")
    report["returned_columns"] = list(frame.columns)
    report["raw_rows"] = len(frame)
    required = ["date", "open", "high", "low", "close", "volume", "amount"]
    missing = [col for col in required if col not in frame.columns]
    if missing:
        raise ValueError("Missing columns: " + ",".join(missing))
    frame["date"] = pd.to_datetime(frame["date"]).dt.strftime("%Y-%m-%d")
    frame = frame[(frame.date >= "2020-07-01") & (frame.date <= "2026-11-20")].sort_values("date")
    report["period_rows"] = len(frame)
    report["first_date"] = frame.date.iloc[0] if len(frame) else None
    report["last_date"] = frame.date.iloc[-1] if len(frame) else None
    report["null_counts"] = {col: int(pd.to_numeric(frame[col], errors="coerce").isna().sum()) for col in required[1:]}
    report["zero_amount_rows"] = int((pd.to_numeric(frame["amount"], errors="coerce") == 0).sum())
    if len(frame) < 1500 or report["last_date"] != "2026-11-20" or any(report["null_counts"].values()):
        raise ValueError("Incomplete date coverage or required fields")
    report["status"] = "data_fields_passed"
    baseline = Path("results/000688_daily.csv")
    if baseline.exists():
        original = pd.read_csv(baseline)
        report["baseline_columns"] = list(original.columns)
        if "date" in original:
            common = frame.merge(original, on="date", suffixes=("_tx", "_em"))
            report["overlap_rows"] = len(common)
            report["missing_baseline_dates"] = sorted(set(original.date.astype(str)) - set(frame.date))
            for field in ["open", "high", "low", "close"]:
                a, b = field + "_tx", field + "_em"
                if a in common and b in common:
                    report[field + "_max_abs_diff"] = float((pd.to_numeric(common[a])-pd.to_numeric(common[b])).abs().max())
            if len(report["missing_baseline_dates"]) or any(report.get(f+"_max_abs_diff", 0)>0.02 for f in ["open","high","low","close"]):
                report["status"] = "comparison_failed"
            else:
                report["status"] = "price_comparison_passed"
except Exception as exc:
    report["error"] = repr(exc)
finally:
    Path("results").mkdir(exist_ok=True)
    Path("results/tencent_alternate_candidate.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
# Diagnostic-only workflow: report carries acceptance status.
