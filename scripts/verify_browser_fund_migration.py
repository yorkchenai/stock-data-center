"""Cross-check the live browser run. Market rows are read locally and never enter the report."""
import argparse
from datetime import datetime
import json
from math import isclose
from pathlib import Path

import pandas as pd

from stock_analysis import funds
from stock_analysis.fund_charts import rank_fund
from stock_analysis.indicators import calculate_indicators
from stock_analysis.sector_data import read_catalog
from stock_analysis.sector_signals import valid_runs


def equal(left, right, tag):
    if left is None or right is None or not isinstance(left, (float, int)) or not isinstance(right, (float, int)):
        if left != right:
            raise ValueError(f"{tag}: {left} != {right}")
    elif not isclose(left, right, rel_tol=1e-9, abs_tol=1e-9):
        raise ValueError(f"{tag}: {left} != {right}")


def verify_nav(item, metadata, code):
    js = item["fund"]
    retrieved = datetime.fromisoformat(js["source"]["retrieved_at"])
    data = funds.download(funds.HISTORY_URL.format(code=code), timeout=15)
    py = funds.parse_history(data, code, metadata.get(code), retrieved)
    keys = ("date", "unit_nav", "accumulated_nav", "return_index", "cash_distribution", "split_factor", "return_issue")
    equal(len(js["rows"]), len(py["rows"]), f"{code} NAV count")
    for key in ("code","name","category","valuation_frequency","return_basis"):
        equal(js[key],py[key],f"{code} {key}")
    for left,right in zip(js["rows"],py["rows"]):
        for key in keys:
            equal(left.get(key),right.get(key),f"{code} {right['date']} {key}")
    return py


def verify_rank(item, fund, code):
    actual = item["report"]
    if not item.get("sessions") or not item.get("histories"):
        return {"status": actual["status"], "verified":False}
    catalog = read_catalog()
    sessions = pd.DatetimeIndex(item["sessions"])
    hist = {key:pd.DataFrame(record["rows"]).set_index("date") for key,record in item["histories"].items()}
    for key,frame in hist.items():
        frame.index = pd.to_datetime(frame.index)
        hist[key] = frame.loc[catalog[key]["known_live_from"] or "2021-01-04":]
    day = datetime.fromisoformat(actual["computed_at"]).astimezone(funds.SHANGHAI).date().isoformat()
    expected = rank_fund(fund,hist,catalog,sessions,day)
    for key in ("status","model_as_of","markets","candidate_count"):
        equal(actual[key],expected[key],f"{code} rank {key}")
    equal([r["code"] for r in actual["sectors"]],[r["code"] for r in expected["sectors"]],f"{code} order")
    checks=0
    for a,b in zip(actual["sectors"],expected["sectors"]):
        for key in ("beta","stability","quality","holdings"):
            if key=="holdings":
                for field in b[key]:
                    equal(a[key][field],b[key][field],f"{code} holdings {field}")
            else:
                equal(a[key],b[key],f"{code} sector {a['code']} {key}")
            checks+=1
        for window,stats in b["windows"].items():
            for field,value in stats.items():
                equal(a["windows"][str(window)][field],value,f"{code} {a['code']} {window} {field}")
                checks+=1
    return {"verified":True,"compared_fields":checks,"available":actual["index_coverage"]["available"],
            "ranked":[r["code"] for r in actual["sectors"]],"model_date":actual["model_as_of"]}


def verify_chart(item, code):
    chart = item.get("chart")
    if not chart:
        return {"verified":False,"status":"target_not_ranked"}
    raw = item["histories"][chart["code"]]["rows"]
    frame = pd.DataFrame(raw)
    frame["date"] = pd.to_datetime(frame["date"])
    frame = frame.set_index("date")
    sessions = pd.DatetimeIndex([row["date"] for row in chart["rows"]])
    observed = pd.Series(sessions.isin(frame.index),index=sessions)
    pieces=[calculate_indicators(block.reset_index()).set_index("date")
            for _,block in frame.groupby(valid_runs(observed))]
    series=pd.concat(pieces).reindex(sessions)
    keys=("MA5","MA10","MA20","MA60","VOL5","VOL10","volume")
    for row in chart["rows"]:
        expected=series.loc[row["date"]]
        for field in keys:
            value=expected["volume_lots" if field=="volume" else field]
            equal(row[field],None if pd.isna(value) else float(value),f"{code} {row['date']} {field}")
    return {"verified":True,"code":chart["code"],"last":chart["last"],"source":chart["source"]["id"],
            "unit":chart["volume_unit"],"compared_values":len(keys)*len(chart["rows"])}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input",type=Path)
    parser.add_argument("output",type=Path)
    args=parser.parse_args()
    sample=json.loads(args.input.read_text(encoding="utf-8"))
    metadata=funds.current_catalog()
    report={}
    for code,item in sample["funds"].items():
        nav=verify_nav(item,metadata,code)
        report[code]={"nav":{"rows":len(nav["rows"]),"first":nav["rows"][0]["date"],"last":nav["rows"][-1]["date"],
                            "latest":nav["rows"][-1]["unit_nav"],"gaps":sum(row["return_index"] is None for row in nav["rows"])},
                      "ranking":verify_rank(item,nav,code),"chart":verify_chart(item,code)}
    if set(report)!={"110022","006751","003095"}:
        raise ValueError("Incomplete three-fund browser run")
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")


if __name__=="__main__":
    main()
