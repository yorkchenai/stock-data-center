"""Compare the shared risk engine with independent arithmetic on confirmed fund histories."""

from argparse import ArgumentParser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
from math import isclose
from pathlib import Path

from scripts.audit_fund_panel import ROOT, independent, run_engine
from stock_analysis.funds import SHANGHAI, load_fund

CODES = ("014194", "018993", "110022", "110017", "110007")
METRICS = ("volatility", "sharpe", "sortino")


def audit_fund(fund):
    engine = run_engine(ROOT, fund)
    reference = engine["reference"]
    assert reference["annual_rate"] == 0.025 and reference["observations_per_year"] == 252
    intervals = {}
    for period in ("3m", "1y"):
        window = engine["windows"][period]
        start, end = window.get("start"), window.get("end")
        expected = independent(fund["rows"], None, start, end, engine["normal_frequency"], reference) if start and end else {}
        metrics = {}
        for name in METRICS:
            actual = window["metrics"][name]
            value = actual["value"]
            check = expected.get(name)
            assert (value is None) == (check is None), f"{fund['code']} {period} {name}: availability mismatch"
            if value is not None:
                assert isclose(value, check, abs_tol=1e-10, rel_tol=1e-10), f"{fund['code']} {period} {name}: value mismatch"
            metrics[name] = {"value":value,"reason":actual["reason"],
                             "absolute_difference":abs(value-check) if value is not None else None}
        intervals[period] = {"start":start,"end":end,"observations":window["observations"],"metrics":metrics}
    return {"code":fund["code"],"name":fund["name"],"source":fund["source"]["name"],
            "last_confirmed_nav_date":fund["rows"][-1]["date"],"reference":reference,"intervals":intervals}


def from_archive(path):
    archive = json.loads(path.read_text())
    snapshot = archive["snapshot"]
    if archive.get("archive_only") is not True or snapshot["asset_type"] != "fund":
        raise ValueError("仅使用基金复算档案里的确认净值记录。")
    data = snapshot["raw_data"]
    return {**data["fund"],"rows":data["history"]}


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--archive", action="append", type=Path, default=[])
    args = parser.parse_args()
    if args.archive:
        funds = [from_archive(path) for path in args.archive]
    else:
        with ThreadPoolExecutor(max_workers=2) as executor:
            funds = list(executor.map(load_fund, CODES))
    report = [audit_fund(fund) for fund in funds]
    print(json.dumps({"run_at":datetime.now(SHANGHAI).isoformat(),"funds":report}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
