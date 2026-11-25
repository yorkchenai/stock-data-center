"""Local fund chart API and authorized static chart packages."""
from argparse import ArgumentParser
from datetime import datetime
from functools import lru_cache
import json
from pathlib import Path
from time import monotonic

import pandas as pd

from . import funds
from .data import FetchError, fetch_daily
from .indicators import calculate_indicators
from .sector_data import ROOT, checked_volume_source, collect_indices, read_catalog, session_index, summarize_index
from .sector_holdings import holdings_evidence
from .sector_model import alignment, rank_associations
from .sector_signals import finite_or_none, technical_series, valid_runs
from .symbols import resolve_symbol
from .validation import audit_calendar, last_completed_session

HISTORY_START = "2021-01-04"
INDEX_CACHE_SECONDS = 1800
MODEL_CACHE_SECONDS = 300
PRICE_FIELDS = ("open", "high", "low", "close", "MA5", "MA10", "MA20", "MA60")
VOLUME_FIELDS = ("volume", "VOL5", "VOL10")
STOCK_SOURCES = {"eastmoney": ("东方财富", "https://quote.eastmoney.com/center/hszs.html"),
                 "tencent": ("腾讯财经", "https://gu.qq.com/")}


def now_shanghai():
    return datetime.now(funds.SHANGHAI)


@lru_cache(maxsize=2)
def index_snapshot(end, interval):
    return funds.coalesce(("fund-chart-indices", end, interval),
                          lambda: (now_shanghai().isoformat(), *collect_indices(HISTORY_START, end)))


def available_indices(histories, catalog, sessions):
    recent = sessions[-150:]
    markets, candidates = [], []
    for code, item in catalog.items():
        frame = histories.get(code)
        if frame is not None and frame.reindex(recent).close.notna().sum() >= 120:
            (markets if item["role"] == "market" else candidates).append(code)
    return markets, candidates


def rank_fund(fund, histories, catalog, sessions, today):
    markets, candidates = available_indices(histories, catalog, sessions)
    evidence = json.loads((ROOT / "research/sector_holdings_evidence.json").read_text(encoding="utf-8"))
    holdings = holdings_evidence(fund["code"], evidence["reports"], evidence["classifications"], catalog, today)
    returns = alignment(fund, histories, sessions)
    outcome = rank_associations(returns, candidates, markets, holdings["sector_support"], keep_profiles=False)
    ranked = []
    for position, item in enumerate(outcome["ranked"], 1):
        sector = item["code"]
        support = item["holdings_evidence"]
        ranked.append({
            "code": sector, "name": catalog[sector]["name"], "rank": position, "quality": item["quality"],
            "beta": item["beta"], "stability": item["positive_fraction"],
            "windows": {window: item["windows"][window] for window in (60, 120)},
            "holdings": {
                "status": "direct_support" if support else "unverified",
                "period_end": holdings.get("period_end"),
                "source": holdings.get("source"),
                "weight_pct_nav": support["known_weight_pct_nav"] if support else None,
            },
        })
    return {"status": outcome["status"], "model_as_of": outcome.get("as_of"),
            "markets": markets, "candidate_count": len(candidates), "sectors": ranked}


@lru_cache(maxsize=16)
def _fund_context(code, end, index_interval, model_interval):
    fund = funds.load_fund(code)
    timestamp = now_shanghai().isoformat()
    latest = fund["rows"][-1]["date"]
    header = {"schema_version": 1, "kind": "fund_sector_analysis", "fund_code": code,
              "fund_as_of": latest, "computed_at": timestamp, "history_start": HISTORY_START}
    if fund["category"] not in {"stock", "mixed"} or fund.get("valuation_frequency") != "daily":
        return fund, {}, {**header, "status": "unsupported_fund", "sectors": []}, {}
    index_at, frames, coverage = index_snapshot(end, index_interval)
    header["indices_retrieved_at"] = index_at
    catalog = read_catalog()
    eligible = {key: frame.loc[catalog[key]["known_live_from"] or HISTORY_START:]
                for key, frame in frames.items()}
    sessions = session_index(HISTORY_START, end)
    try:
        result = rank_fund(fund, eligible, catalog, sessions, end)
    except ValueError as failure:
        # A mismatched or unsupported fund series is still available on the net-value page.
        result = {"status": "fund_data_unavailable", "reason": str(failure), "sectors": []}
    if not frames:
        result["status"] = "indices_unavailable"
    for entry in result["sectors"]:
        entry["index_as_of"] = coverage[entry["code"]]["last"]
    if result.get("model_as_of"):
        after = pd.Timestamp(result["model_as_of"])
        result["model_age_sessions"] = int((sessions > after).sum())
    result["computed_at"] = now_shanghai().isoformat()
    return fund, frames, {**header, **result}, coverage


def fund_context(code):
    if not funds.CODE.fullmatch(code):
        raise ValueError("请提供六位基金代码。")
    clock = monotonic()
    end = now_shanghai().date().isoformat()
    index_interval = int(clock / INDEX_CACHE_SECONDS)
    model_interval = int(clock / MODEL_CACHE_SECONDS)
    return funds.coalesce(("fund-chart-model", code, end, index_interval, model_interval),
                          lambda: _fund_context(code, end, index_interval, model_interval))


def chart_payload(fund_code, entry, history, source, quality, volume_unit, as_of):
    first, last = (day.date().isoformat() for day in (history.index[0], history.index[-1]))
    fields = PRICE_FIELDS + (VOLUME_FIELDS if volume_unit else ())
    bars = [{"date": day.date().isoformat(), **{field: finite_or_none(row[field]) for field in fields}}
            for day, row in history.iterrows()]
    return {
        "schema_version": 1, "kind": "fund_sector_history", "fund_code": fund_code, "code": entry["code"],
        "name": entry["name"], "model_as_of": as_of, "model_index_as_of": entry.get("index_as_of", last),
        "first": first, "last": last, "basis": "price", "currency": "CNY", "volume_unit": volume_unit,
        "source": source, "quality": quality, "rows": bars,
    }


def index_payload(fund_code, entry, frame, coverage, as_of):
    """Retain the issuer history used by existing chart imports and the price-only fallback."""
    start, last = coverage["first"], coverage["last"]
    sessions = session_index(start, last)
    for field in ("open", "high", "low"):
        if field not in frame:
            frame = frame.assign(**{field: float("nan")})
    volume_source = checked_volume_source(coverage)
    volume_unit = coverage["volume_unit"] if volume_source and "volume" in frame else None
    if volume_unit:
        frame = frame.assign(volume=frame.volume.mul(volume_source["conversion_factor"]))
    # Keep blank sessions so rolling windows and charts do not bridge known gaps.
    adjusted = technical_series(frame, sessions, volume_unit=volume_unit)
    if volume_unit and adjusted.volume.isna().all():
        volume_unit = None
    volume_status = ("available" if volume_unit else "invalid_provenance" if coverage.get("volume_unit") and not volume_source
                     else "unit_unverified" if "volume" in frame and frame.volume.notna().any() and not volume_source
                     else "missing")
    source = {"name": "中证指数有限公司", "url": coverage.get("definition") or coverage["source_url"],
              "api_url": coverage["source_url"], "permission": coverage["permission"],
              "volume_unit_evidence": coverage["volume_unit_evidence"] if volume_unit else None,
              "volume": volume_source if volume_unit else None}
    quality = {**{key: coverage[key] for key in ("count", "internal_gaps", "ohlc_rows")},
               "volume_status": volume_status, "volume_coverage": coverage.get("volume_coverage")}
    return chart_payload(fund_code, entry, adjusted, source, quality, volume_unit, as_of)


@lru_cache(maxsize=32)
def stock_chart_history(instrument, end, cache_interval):
    def validate(frame):
        audit_calendar(frame, instrument, HISTORY_START, end)

    frame, provenance = fetch_daily(instrument, HISTORY_START, end, validator=validate)
    if provenance["volume_unit"] != "100-share lots":
        raise ValueError("股票行情引擎返回未知的成交量单位。")
    first, last = (day.date().isoformat() for day in (frame.date.iloc[0], frame.date.iloc[-1]))
    sessions = session_index(first, last)
    observed = pd.Series(sessions.isin(frame.date), index=sessions)
    # Calculate each continuous block with the stock engine, then restore missing sessions as nulls.
    pieces = [calculate_indicators(block.reset_index()).set_index("date")
              for _, block in frame.set_index("date").groupby(valid_runs(observed))]
    history = pd.concat(pieces).reindex(sessions).rename(columns={"volume_lots": "volume"})
    source_id = provenance["source"]
    name, url = STOCK_SOURCES[source_id]
    source = {"id": source_id, "name": name, "url": url, "price_adjustment": provenance["adjustment"]}
    gaps = len(sessions) - len(frame)
    quality = {"count": len(frame), "internal_gaps": gaps, "ohlc_rows": len(frame), "volume_status": "available",
               "volume_coverage": {"first": first, "last": last, "missing_sessions": gaps,
                                   "zero_rows": int(frame.volume_lots.eq(0).sum()), "invalid_rows": 0,
                                   "missing_field_rows": 0}}
    return history, source, quality


def sector_analysis(code):
    return fund_context(code)[2]


def sector_history(code, sector):
    _, frames, analysis, coverage = fund_context(code)
    entry = next((item for item in analysis["sectors"] if item["code"] == sector), None)
    if entry is None:
        raise ValueError("该指数不在当前基金的可用关联结果中，请更新关联分析。")
    end = last_completed_session(now_shanghai())
    try:
        instrument = resolve_symbol(sector, kind="index")
    except ValueError:
        fallback = "unsupported_symbol"
    else:
        interval = int(monotonic() / INDEX_CACHE_SECONDS)
        try:
            history, source, quality = funds.coalesce(("fund-stock-index", instrument, end, interval),
                                                      lambda: stock_chart_history(instrument, end, interval))
        except (FetchError, ValueError):
            fallback = "stock_sources_unavailable"
        else:
            return chart_payload(code, entry, history, source, quality, "手", analysis["model_as_of"])
    frame = frames[sector].loc[:end]
    if frame.empty:
        raise ValueError("该指数尚无已收盘行情。")
    details = {**coverage[sector], **summarize_index(frame, HISTORY_START, end)}
    result = index_payload(code, entry, frame, details, analysis["model_as_of"])
    result["quality"]["stock_chart_status"] = fallback
    return result


def export_bundle(code):
    fund, frames, analysis, coverage = fund_context(code)
    return {
        "schema_version": 1, "kind": "fund_chart_bundle", "fund": fund, "analysis": analysis,
        "indices": [index_payload(code, item, frames[item["code"]], coverage[item["code"]], analysis["model_as_of"])
                    for item in analysis["sectors"]],
    }


def main():
    parser = ArgumentParser(description="Generate a single authorized local fund chart package")
    parser.add_argument("code")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = json.dumps(export_bundle(args.code), ensure_ascii=False, allow_nan=False)
    args.output.write_text(output + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
