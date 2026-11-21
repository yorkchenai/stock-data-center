"""One-symbol pipeline, with a fresh output directory for every invocation."""
from dataclasses import asdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
import argparse
import json
import tempfile

import pandas as pd

from .charts import CHART_FILES, generate_charts
from .data import FetchError, fetch_daily
from .indicators import calculate_indicators
from .symbols import resolve_symbol
from .validation import audit_calendar, normalize_daily

ANALYSIS_LAYERS = ["价格定位置", "均线判趋势", "成交量看配合", "MACD看动量变化", "RSI看相对强弱"]


def run_analysis(instrument, start, end, output_root=Path("results"), input_csv=None, source="auto", window=120):
    start = pd.Timestamp(start).date().isoformat()
    end = pd.Timestamp(end).date().isoformat()
    if start > end or window < 1:
        raise ValueError("Require start <= end and positive chart window")
    parent = Path(output_root) / instrument.key
    parent.mkdir(parents=True, exist_ok=True)
    prefix = datetime.now(ZoneInfo("UTC")).strftime("%Y%m%dT%H%M%SZ_")
    out = Path(tempfile.mkdtemp(prefix=prefix, dir=parent))
    report = {"status": "running", "instrument": asdict(instrument), "start": start, "end": end,
              "output_dir": str(out.resolve()), "analysis_layers": ANALYSIS_LAYERS,
              "supplementary_indicator": "ADX14", "adjustment": "none"}
    try:
        def validate(frame):
            audit = audit_calendar(frame, instrument, start, end)
            if instrument.kind == "index" and audit["interior_missing_sessions"]:
                raise ValueError("Index has missing interior trading sessions")
            return audit

        if input_csv is not None:
            frame = normalize_daily(pd.read_csv(input_csv))
            frame = frame[frame.date.between(start, end)].reset_index(drop=True)
            if frame.empty:
                raise ValueError("Input CSV has no rows in requested period")
            report["provenance"] = {"source": "local_csv", "path": str(Path(input_csv).resolve()),
                                    "adjustment": "user-supplied, must be unadjusted"}
        else:
            frame, report["provenance"] = fetch_daily(instrument, start, end, source, validator=validate)
        report["validation"] = validate(frame)
        frame.to_csv(out / "daily.csv", index=False, date_format="%Y-%m-%d")
        indicators = calculate_indicators(frame)
        indicators.to_csv(out / "indicators.csv", index=False, date_format="%Y-%m-%d")
        # pandas emits strict JSON null for NaN, suitable for future frontends.
        (out / "indicators.json").write_text(indicators.assign(date=indicators.date.dt.strftime("%Y-%m-%d")).to_json(orient="records", double_precision=15), encoding="utf-8")
        generate_charts(indicators, instrument, out / "charts", window)
        report.update(status="success", rows=len(frame), first_date=str(frame.date.iloc[0].date()),
                      last_date=str(frame.date.iloc[-1].date()),
                      files=["daily.csv", "indicators.csv", "indicators.json"] + ["charts/" + name for name in CHART_FILES])
    except Exception as exc:
        report.update(status="failed", error=f"{type(exc).__name__}: {exc}")
        if isinstance(exc, FetchError):
            report["attempts"] = exc.attempts
        raise
    finally:
        (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    return indicators, report


def main(argv=None):
    parser = argparse.ArgumentParser(description="A-share/index historical daily analysis (unadjusted prices)")
    parser.add_argument("symbol", help="600519, sz000001, sh000001, 000688, etc.")
    parser.add_argument("--kind", choices=["auto", "stock", "index"], default="auto")
    parser.add_argument("--start", default="2020-01-01")
    yesterday = datetime.now(ZoneInfo("Asia/Shanghai")).date() - timedelta(days=1)
    parser.add_argument("--end", default=yesterday.isoformat(), help="YYYY-MM-DD, default yesterday in Asia/Shanghai")
    parser.add_argument("--source", choices=["auto", "eastmoney", "tencent"], default="auto")
    parser.add_argument("--input", type=Path, help="Offline CSV in the canonical daily schema")
    parser.add_argument("--output-root", type=Path, default=Path("results"))
    parser.add_argument("--window", type=int, default=120)
    args = parser.parse_args(argv)
    try:
        _, report = run_analysis(resolve_symbol(args.symbol, args.kind), args.start, args.end,
                                 args.output_root, args.input, args.source, args.window)
    except Exception as exc:
        parser.exit(1, f"Analysis failed: {exc}\nSee the new run's report.json under {args.output_root}\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
