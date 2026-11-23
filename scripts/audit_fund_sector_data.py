"""Probe fund/sector data and write only aggregate evidence, never histories."""
from argparse import ArgumentParser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
from pathlib import Path
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode

import numpy as np
import pandas as pd
import exchange_calendars as xcals

from stock_analysis import funds

ROOT = Path(__file__).resolve().parents[1]
CSI_URL = "https://www.csindex.com.cn/csindex-home/perf/index-perf"
CONSTRAINT_CODES = {401, 403, 429}


def session_index(start, end):
    return xcals.get_calendar("XSHG").sessions_in_range(start, end)


def read_catalog():
    payload = json.loads((ROOT / "research/sector_indices.json").read_text())
    return {item["code"]: {**item, "issuer": payload["issuer"], "calendar":payload["calendar"],
                           "basis":"price", "currency":"CNY",
                           "known_live_from":"2024-06-01" if item["code"].startswith("932") else None,
                           "definition": ("https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/"
                                          f"indices/detail/files/zh_CN/{item['code']}factsheet.pdf")}
            for item in payload["indices"]}


def csi_history(item, start, end, get=funds.download):
    args = urlencode({"indexCode":item["code"], "startDate":start.replace("-", ""), "endDate":end.replace("-", "")})
    records = json.loads(get(f"{CSI_URL}?{args}")).get("data")
    if not isinstance(records, list) or not records:
        raise ValueError("empty_index_history")
    if any(str(row.get("indexCode")) != item["code"] or row.get("indexNameCnAll") != item["name"] for row in records):
        raise ValueError("index_identity_mismatch")
    mapped = {"open":"open","high":"high","low":"low","close":"close",
              "volume":"tradingVol","turnover":"tradingValue"}
    frame = pd.DataFrame({key:[row.get(value) for row in records] for key,value in mapped.items()})
    frame.index = pd.to_datetime([row["tradeDate"] for row in records], format="%Y%m%d", errors="raise")
    frame = frame.sort_index()
    for name in mapped:
        frame[name] = pd.to_numeric(frame[name], errors="coerce")
    if (frame.index.has_duplicates or not frame.index.isin(session_index(start,end)).all()
            or not np.isfinite(frame.close).all() or (frame.close <= 0).any()):
        raise ValueError("invalid_dates_or_prices")
    ohlc = frame[["open","high","low"]]
    valid = (np.isfinite(ohlc).all(axis=1) & (ohlc > 0).all(axis=1) & (frame.low <= frame[["open","close"]].min(axis=1))
             & (frame.high >= frame[["open","close"]].max(axis=1)))
    frame.loc[~valid,["open","high","low"]] = np.nan
    amount = frame[["volume","turnover"]]
    frame[amount.columns] = amount.where(np.isfinite(amount) & (amount >= 0))
    return frame


def error_status(exc):
    if isinstance(exc, HTTPError):
        return {"status":"access_restricted" if exc.code in CONSTRAINT_CODES else "http_error",
                "http_status":exc.code}
    if isinstance(exc, URLError):
        return {"status":"network_error", "reason":type(exc.reason).__name__}
    if isinstance(exc, OSError):
        return {"status":"network_error", "reason":type(exc).__name__}
    return {"status":"invalid_data", "reason":str(exc)[:110]}



def read_with_transient_retry(get):
    try:
        return get()
    except (ValueError, OSError) as exc:
        retryable_data = str(exc).startswith("数据源缺少字段 fS_code")
        if not retryable_data and error_status(exc)["status"]!="network_error":
            raise
        sleep(2)
        return get()

def summarize_index(frame, start, end):
    expected = session_index(start, end)
    inner = expected[(expected >= frame.index[0]) & (expected <= frame.index[-1])]
    return {"status":"ok", "first":frame.index[0].date().isoformat(), "last":frame.index[-1].date().isoformat(),
            "count":len(frame), "internal_gaps":len(inner.difference(frame.index)),
            "missing_at_start":int((expected < frame.index[0]).sum()),
            "missing_at_end":int((expected > frame.index[-1]).sum()),
            "ohlc_rows":int(frame[["open","high","low","close"]].notna().all(axis=1).sum()),
            "volume_rows":int(frame.volume.notna().sum()), "volume_unit":None,
            "source_url":CSI_URL, "permission":"public_endpoint_research_probe_no_redistribution_license"}


def collect_indices(start, end):
    frames, report = {}, {}
    restricted = False
    for code,item in read_catalog().items():
        if restricted:
            report[code] = {**item, "status":"not_requested_after_restriction"}
            continue
        try:
            frame = read_with_transient_retry(lambda:csi_history(item, start, end))
            report[code] = {**item, **summarize_index(frame,start,end)}
            frames[code] = frame
        except (ValueError, KeyError, TypeError, OSError) as exc:
            status = error_status(exc)
            restricted = status["status"] == "access_restricted"
            report[code] = {**item, **status}
        sleep(.6)
    return frames, report


def collect_funds(start, end):
    panel = json.loads((ROOT / "research/fund_sector_panel.json").read_text())
    fixture = json.loads((ROOT / "tests/fixtures/fund_generalization_panel.json").read_text())
    catalog = funds.parse_catalog(funds.download(funds.CATALOG_URL))
    histories, report = {}, {}
    restricted = False
    for category,codes in panel.items():
        expected = {code for code,*_ in fixture["cohorts"][category]}
        if set(codes) - expected:
            raise ValueError("Study panel must come from the fixed phase-four groups")
        for code in codes:
            if restricted:
                report[code] = {"status":"not_requested_after_restriction"}
                continue
            metadata = catalog.get(code) or {}
            try:
                fund = read_with_transient_retry(lambda:funds.parse_history(
                    funds.download(funds.HISTORY_URL.format(code=code)),code,metadata))
                rows = fund["rows"]
                report[code] = {"status":"ok" if fund["category"] == ("stock" if category == "active_stock" else "mixed")
                                else "type_mismatch", "category":fund["category"], "name":fund["name"],
                                "count":len(rows), "first":rows[0]["date"], "last":rows[-1]["date"],
                                "usable_levels":sum(row["return_index"] is not None for row in rows),
                                "distribution_events":sum(bool(row["cash_distribution"]) for row in rows),
                                "unverified_events":sum(bool(row["return_issue"]) for row in rows),
                                "source_url":fund["source"]["url"]}
                if report[code]["status"] == "ok":
                    histories[code] = fund
            except (ValueError, KeyError, TypeError, OSError) as exc:
                status = error_status(exc)
                restricted = status["status"] == "access_restricted"
                report[code] = {**status, "category":metadata.get("category")}
            sleep(.6)
    return histories, report


def collect(start,end):
    with ThreadPoolExecutor(max_workers=2) as pool:
        left = pool.submit(collect_funds,start,end)
        right = pool.submit(collect_indices,start,end)
        try:
            funds_data, funds_report = left.result()
        except (ValueError, OSError) as exc:
            funds_data, funds_report = {}, {"catalog":error_status(exc)}
        index_data, index_report = right.result()
    summary = {"schema_version":1,"period":{"start":start,"end":end},
               "funds":funds_report,"indices":index_report,
               "as_of":datetime.now(funds.SHANGHAI).isoformat()}
    return funds_data,index_data,summary


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--start", default="2021-01-04")
    parser.add_argument("--end", default=datetime.now(funds.SHANGHAI).date().isoformat())
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    _,_,report = collect(args.start,args.end)
    args.output.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n")


if __name__ == "__main__":
    main()
