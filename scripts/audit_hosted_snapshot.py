"""Independently audit a private test Site export. Prints only aggregate evidence."""

from argparse import ArgumentParser
from datetime import datetime
from math import isclose, isfinite
from pathlib import Path
from zoneinfo import ZoneInfo
import json

import numpy as np
import pandas as pd

from scripts.audit_fund_panel import independent
from stock_analysis.indicators import calculate_indicators
from stock_analysis.sector_holdings import holdings_evidence
from stock_analysis.sector_model import alignment, rank_associations


STOCK_FIELDS = (
    "open", "high", "low", "close", "volume_lots", "turnover_cny", "change_pct",
    "MA5", "MA10", "MA20", "MA60", "VOL5", "VOL10", "EMA12", "EMA26",
    "DIF", "DEA", "MACD_hist", "RSI6", "RSI12", "RSI14", "RSI24", "ADX14", "+DI", "-DI",
)
FUND_METRICS = ("return", "drawdown", "volatility", "sortino", "sharpe")


def compare(left, right, path):
    if type(left) is float or type(right) is float:
        if left is None or right is None or not isclose(left, right, rel_tol=1e-9, abs_tol=1e-9):
            raise ValueError(f"数值差异：{path}")
        return abs(left - right)
    if left != right:
        raise ValueError(f"数据差异：{path}")
    return 0.0


def audit_stock(snapshot):
    raw = snapshot["raw_data"]["history"]
    expected = calculate_indicators(pd.DataFrame(raw))
    actual = pd.DataFrame(snapshot["indicators"]["rows"])
    if expected.date.dt.strftime("%Y-%m-%d").tolist() != actual.date.tolist():
        raise ValueError("股票日线日期不一致")
    max_delta = 0.0
    for name in STOCK_FIELDS:
        left, right = expected[name].astype(float), actual[name].astype(float)
        np.testing.assert_allclose(left, right, atol=1e-9, rtol=1e-9, equal_nan=True, err_msg=name)
        delta = (left - right).abs().max()
        if isfinite(delta):
            max_delta = max(max_delta, float(delta))
    return {"rows":len(raw), "checked_fields":len(STOCK_FIELDS), "max_abs_error":max_delta}


def audit_risk(rows, fund, risk):
    checked, skipped, max_delta = 0, {}, 0.0
    daily = fund["valuation_frequency"] == "daily" and fund["category"] not in {"qdii", "fof", "money"}
    for period, window in risk["windows"].items():
        start, end = window["start"], window["end"]
        computed = independent(rows, risk["risk_free"], start, end, daily) if start and end else {}
        for metric in FUND_METRICS:
            observed = window["metrics"][metric]
            key = f"{period}.{metric}"
            if metric not in computed:
                if observed["value"] is not None:
                    raise ValueError(f"缺少独立算法输入：{key}")
                skipped[key] = observed["reason"]
                continue
            max_delta = max(max_delta, compare(computed[metric], observed["value"], key))
            checked += 1
    return {"checked":checked,"max_abs_error":max_delta,"missing":skipped}


def audit_sectors(fund, snapshot, calendar, config):
    expected = snapshot["models"]["sectors"]["report"]
    if not expected or expected["status"] not in {"ok", "no_reliable_association"}:
        return {"missing": expected["status"] if expected else "indices_unavailable"}
    as_of = datetime.fromisoformat(expected["computed_at"]).astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat()
    sessions = [day for day in calendar["sessions"] if "2021-01-04" <= day <= as_of]
    recent = set(sessions[-150:])
    catalog = config["indices"]
    histories, markets, candidates = {}, [], []
    market_inputs = snapshot["raw_data"]["sector_index_history"]
    for code, entry in catalog.items():
        if code not in market_inputs:
            continue
        start = entry.get("known_live_from") or "2021-01-04"
        prices = [row for row in market_inputs[code]["rows"] if row["date"] >= start]
        histories[code] = pd.DataFrame(prices).set_index("date")
        if sum(row["date"] in recent for row in prices) >= 120:
            (markets if entry["role"] == "market" else candidates).append(code)
    evidence = config["holdings"]
    groups = holdings_evidence(fund["code"], evidence["reports"], evidence["classifications"], catalog, as_of)["sector_support"]
    levels = alignment(fund, histories, pd.DatetimeIndex(sessions))
    result = rank_associations(levels, candidates, markets, groups)
    compare(result["status"], expected["status"], "sector_status")
    compare(result["as_of"], expected["model_as_of"], "sector_model_as_of")
    compare(len(markets) + len(candidates), expected["index_coverage"]["available"], "index_coverage")
    ranked = [item["code"] for item in result["ranked"]]
    compare(ranked, [item["code"] for item in expected["sectors"]], "sector_ranking")
    max_delta = 0.0
    for py, js in zip(result["ranked"], expected["sectors"]):
        max_delta = max(max_delta, compare(py["beta"], js["beta"], "beta"),
                        compare(py["positive_fraction"], js["stability"], "stability"))
        for size, window in py["windows"].items():
            for key in ("pearson", "partial"):
                max_delta = max(max_delta, compare(window[key], js["windows"][str(size)][key], f"{size}.{key}"))
    return {"coverage":len(markets)+len(candidates),"ranked":ranked,"max_abs_error":max_delta}


def audit_fund(snapshot, calendar, config):
    raw = snapshot["raw_data"]
    rows = raw["history"]
    compare(rows[-1]["date"], snapshot["data_as_of"], "nav_date")
    compare(rows[-1]["unit_nav"], snapshot["summary"]["latest_nav"], "latest_nav")
    fund = {**raw["fund"],"rows":rows}
    return {"rows":len(rows),"risk":audit_risk(rows, fund, snapshot["models"]["risk"]),
            "sectors":audit_sectors(fund, snapshot, calendar, config)}


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("archives", type=Path, nargs="+")
    parser.add_argument("--calendar", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    calendar, config = (json.loads(path.read_text()) for path in (args.calendar, args.config))
    results = []
    for path in args.archives:
        archive = json.loads(path.read_text())
        if not archive.get("archive_only"):
            raise ValueError("文件不是私有测试站点的复算档案")
        snapshot = archive["snapshot"]
        result = {field:snapshot[field] for field in ("symbol","snapshot_id","status","model_version","data_as_of")}
        result.update(audit_stock(snapshot) if snapshot["asset_type"] == "stock" else audit_fund(snapshot, calendar, config))
        results.append(result)
    print(json.dumps(results, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
