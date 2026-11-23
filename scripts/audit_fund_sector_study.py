"""Run the sector study in memory and export aggregate results without time series."""
from argparse import ArgumentParser
from datetime import datetime
import json
from pathlib import Path

import numpy as np
import pandas as pd

from scripts.audit_fund_sector_data import ROOT, collect, read_catalog, session_index
from stock_analysis import funds
from stock_analysis.sector_holdings import holdings_evidence, known_tracking
from stock_analysis.sector_model import FUND, alignment, rank_associations
from stock_analysis.sector_signals import technical_series, technical_snapshot
from stock_analysis.sector_validation import walk_forward


def report_inputs():
    path = ROOT/"research/sector_holdings_evidence.json"
    if not path.exists():
        return [], {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload["reports"],payload["classifications"]


def safe_index_set(histories,catalog,sessions):
    recent = sessions[-150:]
    controls, candidates = [], []
    for code,item in catalog.items():
        frame = histories.get(code)
        if frame is not None and frame.reindex(recent).close.notna().sum()>=120:
            (controls if item["role"]=="market" else candidates).append(code)
    return controls,candidates


def load_local(directory,start,end):
    """Import the caller's authorized fund JSON and index CSV with explicit provenance."""
    catalog = read_catalog()
    spec = json.loads((directory/"manifest.json").read_text(encoding="utf-8"))
    sessions = session_index(start,end)
    fund_data, index_data = {}, {}
    report = {"schema_version":1,"period":{"start":start,"end":end},"funds":{},"indices":{},
              "as_of":datetime.now(funds.SHANGHAI).isoformat()}
    for code in spec.get("funds",[]):
        if not funds.CODE.fullmatch(code):
            raise ValueError("Invalid local fund share code")
        body = json.loads((directory/f"fund-{code}.json").read_text(encoding="utf-8"))
        if body.get("code")!=code or not body.get("source",{}).get("url"):
            raise ValueError("Fund share or source mismatch")
        fund_data[code] = body
        report["funds"][code] = {"status":"ok","source_url":body["source"]["url"],"category":body["category"],
                                 "count":len(body["rows"]),"first":body["rows"][0]["date"],
                                 "last":body["rows"][-1]["date"]}
    for code, meta in spec.get("indices",{}).items():
        expected = catalog[code]
        if (meta.get("license")!="authorized_for_research" or not meta.get("source_url")
                or meta.get("currency")!=expected["currency"] or meta.get("basis")!=expected["basis"]
                or meta.get("calendar")!=expected["calendar"]):
            raise ValueError("Missing permission, source or compatible index basis/calendar")
        frame = pd.read_csv(directory/f"index-{code}.csv", dtype={"code":str})
        if not frame.code.eq(code).all():
            raise ValueError("Index identity mismatch")
        frame.index = pd.to_datetime(frame.pop("date"),format="%Y-%m-%d")
        if frame.index.has_duplicates or not frame.index.is_monotonic_increasing:
            raise ValueError("Index dates must be distinct and ordered")
        frame = frame.loc[start:end]
        if frame.empty or not frame.index.isin(sessions).all() or not np.isfinite(frame.close).all() or (frame.close<=0).any():
            raise ValueError("Invalid local index calendar or closing levels")
        extra = ["open","high","low"]
        if set(extra).intersection(frame.columns):
            if not set(extra).issubset(frame.columns):
                raise ValueError("Supply all of open, high, low or use close-only")
            has_values = frame[extra].notna().any(axis=1)
            valid = ((frame[extra]>0).all(axis=1) & (frame.low<=frame[["open","close"]].min(axis=1))
                     & (frame.high>=frame[["open","close"]].max(axis=1)))
            if (has_values & ~valid).any():
                raise ValueError("Invalid local OHLC")
        if meta.get("volume_unit") and ("volume" not in frame or (frame.volume<0).any()):
            raise ValueError("Invalid local volume")
        index_data[code] = frame
        report["indices"][code] = {**expected,"status":"ok","count":len(frame),
                                   "first":frame.index[0].date().isoformat(),"last":frame.index[-1].date().isoformat(),
                                   "internal_gaps":len(sessions[(sessions>=frame.index[0]) & (sessions<=frame.index[-1])]
                                                       .difference(frame.index)),
                                   "volume_unit":meta.get("volume_unit"),"source_url":meta["source_url"],
                                   "permission":meta["license"]}
    return fund_data,index_data,report


def evaluate(fund_data,index_data,data_report,start,end,predict=True):
    catalog = read_catalog()
    sessions = session_index(start,end)
    # Research uses no reconstructed observations before the documented launch
    # bound. Keep the source coverage audit unchanged so gaps remain visible.
    index_data = {code:frame.loc[catalog[code].get("known_live_from") or start:end]
                  for code,frame in index_data.items()}
    markets, candidates = safe_index_set(index_data,catalog,sessions)
    units = {code:data_report["indices"][code].get("volume_unit") for code in index_data}
    technique = {code:technical_series(frame,sessions,units[code]) for code,frame in index_data.items()}
    reports, classifications = report_inputs()
    result = {}
    for code,fund in fund_data.items():
        latest = min(end,fund["rows"][-1]["date"])
        holdings = holdings_evidence(code,reports,classifications,catalog,latest)
        extra_days = [row["date"] for row in fund["rows"] if start<=row["date"]<=end and pd.Timestamp(row["date"]) not in sessions]
        entry = {"name":fund["name"],"valuation_date":latest,"holdings":holdings,
                 "off_session_nav":{"count":len(extra_days),"examples":extra_days[:5]},
                 "known_tracking":known_tracking(fund,catalog)}
        if fund["category"]=="index":
            result[code] = {**entry,"status":"use_disclosed_tracking"}
            continue
        try:
            returns = alignment(fund,index_data,sessions)
        except ValueError as error:
            result[code] = {**entry,"status":"unsupported_or_invalid_fund", "reason":str(error)}
            continue
        eligible = returns[FUND].notna().sum()
        ranking = rank_associations(returns,candidates,markets,holdings["sector_support"])
        for item in ranking["ranked"]:
            sector = item["code"]
            item["name"] = catalog[sector]["name"]
            item["technique"] = technical_snapshot(technique[sector],latest,units[sector])
            pair = returns.loc[:latest,[FUND,sector]].tail(60).dropna()
            if len(pair)==60 and pair.index.equals(returns.loc[:latest].tail(60).index):
                changes = (1+pair).prod()-1
                item["same_period_60"] = {"start_return":pair.index[0].date().isoformat(),
                                          "end":pair.index[-1].date().isoformat(),"fund":changes[FUND],
                                          "sector":changes[sector]}
        mapped = [item for item in ranking["ranked"] if item["code"] in holdings["sector_support"]]
        verification = {"ranked_with_observed_support":len(mapped),"ranked":len(ranking["ranked"]),
                        "lower_bound_only":True,"mapped_top_positions":holdings.get("mapped_positions",0)}
        # Eligibility by code is fixed ahead of the research window. Today's
        # successful coverage must not choose the historical prediction universe.
        historical_markets = [key for key in catalog if catalog[key]["role"]=="market" and key in index_data]
        historical_sectors = [key for key in catalog if catalog[key]["role"]!="market" and key in index_data]
        forecast = walk_forward(returns,technique,historical_markets,historical_sectors) if predict else {"status":"not_requested"}
        result[code] = {**entry,"valid_return_observations":int(eligible),"association":ranking,
                        "holdings_crosscheck":verification,"prediction":forecast}
    return {"schema_version":1,"data":data_report,"market_controls":markets,"candidate_sectors":candidates,
            "funds":result}


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--start",default="2021-01-04")
    parser.add_argument("--end",default=datetime.now(funds.SHANGHAI).date().isoformat())
    parser.add_argument("--output",type=Path,required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--public-probe",action="store_true")
    source.add_argument("--local-dir",type=Path)
    parser.add_argument("--associations-only",action="store_true")
    args = parser.parse_args()
    inputs = collect(args.start,args.end) if args.public_probe else load_local(args.local_dir,args.start,args.end)
    result = evaluate(*inputs,args.start,args.end,predict=not args.associations_only)
    args.output.write_text(json.dumps(result,indent=2,ensure_ascii=False,allow_nan=False)+"\n",encoding="utf-8")


if __name__=="__main__":
    main()
