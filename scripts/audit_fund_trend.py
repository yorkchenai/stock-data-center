"""Replay the phase-six fund panel with time-ordered cycle and drawdown controls."""
from argparse import ArgumentParser
from dataclasses import asdict
from datetime import datetime
import json
from pathlib import Path

import pandas as pd
import numpy as np

from scripts.audit_fund_sector_data import collect, read_catalog, session_index
from scripts.audit_fund_sector_study import load_local
from stock_analysis import funds
from stock_analysis.fund_trend import (RULES, PRIMARY, complete_periods, decisions,
                                       historical_selector, market_returns, trend_series)
from stock_analysis.fund_trend_backtest import (BASE, EXECUTIONS, OOS_START, drawdown_metrics,
                                               historical_phases, regime_summaries, run_strategies, segments)
from stock_analysis.sector_model import fund_levels, session_levels

CASES = ("110022","006751","003095")


def dateonly(day):
    return pd.Timestamp(day).date().isoformat()


def clean_record(record):
    return {key:dateonly(value) if isinstance(value,pd.Timestamp) else value for key,value in record.items()}


def summarize_cases(levels, trades, metrics, decisions):
    worst = metrics["A"]["max_drawdown_window"]
    if worst is None:
        return {}
    trough = pd.Timestamp(worst["trough"])
    start = pd.Timestamp(worst["start"])
    rows = {}
    for strategy in ("B","C","D"):
        reductions = [row for row in trades[strategy] if row["side"]=="sell" and start<=row["date"]<=trough]
        first = reductions[0] if reductions else None
        entry = next((row for row in trades[strategy] if row["side"]=="buy" and row["date"]>trough),None)
        if first:
            next_ten = levels.loc[first["date"]:].iloc[1:11]
            rebound = next_ten.iloc[-1]/levels.loc[first["date"]]-1 if len(next_ten)==10 else None
            last_decision = next((item for item in decisions if item["decision"]==first["signal"]),None)
        else:
            rebound = last_decision = None
        rows[strategy] = {"first_reduction_in_drawdown":clean_record(first) if first else None,
                          "fund_next_10_sessions":rebound,"first_addition_after_trough":clean_record(entry) if entry else None,
                          "decision_sectors":last_decision["sectors"] if last_decision else [],
                          "fund_movement_trough_to_entry":float(levels.loc[entry["date"]]/levels.loc[trough]-1) if entry else None}
    latest = next((row for row in reversed(decisions) if row["decision"]<=levels.index[-1]),None)
    return {"buy_hold_drawdown":worst,"strategies":rows,
            "latest_signal":{**clean_record(latest)} if latest else None}


def chart_case(code, levels, paths, metrics, rows, trades, output):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    output.mkdir(parents=True,exist_ok=True)
    fig, axes = plt.subplots(4,1,figsize=(13,15),layout="constrained",height_ratios=[1,1,1.2,1])
    colors = dict(zip(("A","B","C","D","E"),("black","#2365a7","#14795f","#b07327","#815f9a")))
    for label,path in paths.items():
        monthly = path.groupby(path.index.to_period("M")).tail(1)
        drawdown = drawdown_metrics(path.value)[0].loc[monthly.index]
        axes[0].plot(monthly.index,monthly.value, label=label,color=colors[label])
        axes[1].plot(drawdown.index,drawdown.mul(100),color=colors[label])
    axes[0].set(title="Cumulative value (month-end samples, initial capital = 1)",ylabel="Value")
    axes[0].legend(ncols=5)
    axes[1].set(title="Drawdown (month-end samples of daily drawdown)",ylabel="%")
    end = paths["C"].index[-1]
    last_year = end-pd.Timedelta(days=365)
    partial = levels.loc[last_year:end].groupby(lambda day: day.to_period("W-FRI")).tail(1)
    risk = paths["C"].risk.loc[last_year:end]
    twin = axes[2].twinx()
    axes[2].plot(partial.index,partial/partial.iloc[0],color="#344455",alpha=.55,label="Fund")
    twin.step(risk.index,risk,where="post",color=colors["C"],label="C exposure")
    signals = [row for row in rows if last_year<=row["decision"]<=end]
    states = {"uptrend":1.0,"neutral":.5,"downtrend":0,None:np.nan}
    for tag,label,yshift in (("fund_state","Fund state",-.065),("sector_state","Sector state",.065)):
        twin.scatter([row["decision"] for row in signals],[states[row[tag]]+yshift for row in signals],
                     s=12,alpha=.7,label=label)
    for side,marker in (("sell","v"),("buy","^")):
        times = [row["date"] for row in trades["C"] if row["side"]==side and row["date"]>=last_year]
        twin.scatter(times,risk.reindex(times),marker=marker,s=32,label=side)
    if signals:
        latest_sectors = ", ".join(f"{row['code']}={row['state']}" for row in signals[-1]["sectors"])
        if latest_sectors:
            axes[2].text(.01,.95,latest_sectors,transform=axes[2].transAxes,va="top",fontsize=8)
    twin.set(ylim=(-.15,1.15),ylabel="Exposure / state")
    twin.legend(ncols=5,loc="lower left",fontsize=8)
    axes[2].set(title="Recent year: weekly fund samples, trend states and executed trades",ylabel="Normalized fund value")
    cells = []
    def percentage(value):
        return f"{value:.1%}" if value is not None else "n/a"
    for label,m in metrics.items():
        cells.append([label,percentage(m["cagr"]),percentage(m["mdd"]),
                      f"{m['calmar']:.2f}" if m["calmar"] is not None else "n/a",
                      percentage(m["phases"].get("up",{}).get("capture")),
                      percentage(m["annual_gross_turnover"]),percentage(m["mean_risk"])])
    axes[3].axis("off")
    table = axes[3].table(cellText=cells,colLabels=["Strategy","CAGR","MDD","Calmar","Up capture","Turnover","Exposure"],
                          cellLoc="center",loc="center")
    table.scale(1,1.8)
    fig.suptitle(f"{code} | Historical scenario, no verified execution",fontsize=16)
    fig.savefig(output/f"{code}-trend.png",dpi=135)
    plt.close(fig)


def run_study(fund_data, index_data, data_report, start, end, charts=None):
    sessions = session_index(start,dateonly(pd.Timestamp(end)+pd.Timedelta(days=35)))
    catalog = read_catalog()
    eligible_frames = {code:frame.loc[catalog[code]["known_live_from"] or start:end]
                       for code,frame in index_data.items()}
    index_levels = {code:session_levels(frame.close,sessions) for code,frame in eligible_frames.items()}
    controls = [key for key in index_levels if catalog[key]["role"]=="market"]
    sectors = [key for key in index_levels if catalog[key]["role"]!="market"]
    holdings = json.loads((Path(__file__).resolve().parents[1]/"research/sector_holdings_evidence.json").read_text())
    report = {}
    def bar_key(rule):
        return rule.sampling,rule.short,rule.long
    variations_by_bars = {bar_key(rule):rule for rule in RULES}
    sector_states = {key:{code:trend_series(index_levels[code],sessions,rule,eligible_frames[code])
                          for code in sectors} for key,rule in variations_by_bars.items()} if fund_data else {}
    for code,fund in fund_data.items():
        latest = min(end,fund["rows"][-1]["date"])
        try:
            levels = fund_levels(fund,sessions).loc[:latest]
        except ValueError as exc:
            report[code] = {"status":"unsupported_fund","reason":str(exc)}
            continue
        chains = segments(levels)
        if not chains:
            report[code] = {"status":"insufficient_contiguous_nav","valid_levels":int(levels.loc[OOS_START:].count())}
            continue
        primary_chain = max(chains,key=len)
        returns = market_returns(levels.reindex(sessions),index_levels)
        select = historical_selector(returns,controls,sectors)
        monthly_days = complete_periods(sessions,"monthly")
        fund_states = {key:trend_series(levels,sessions,rule) for key,rule in variations_by_bars.items()}
        signals = {rule.name:decisions(fund_states[bar_key(rule)],sector_states[bar_key(rule)],sessions,
                                       pd.Timestamp(latest),rule,select) for rule in RULES}
        valid = levels.loc[primary_chain]
        phased = historical_phases(valid)
        paths,trades,results = run_strategies(valid,sessions,signals[PRIMARY.name],BASE,monthly_days)
        costs = {case.name:run_strategies(valid,sessions,signals[PRIMARY.name],case,monthly_days)[2]
                 for case in EXECUTIONS if case!=BASE}
        variations = {rule.name:run_strategies(valid,sessions,signals[rule.name],BASE,monthly_days)[2]
                      for rule in RULES if rule!=PRIMARY}
        other = [{"start":dateonly(chain[0]),"end":dateonly(chain[-1]),"rows":len(chain),
                  "metrics": run_strategies(levels.loc[chain],sessions,signals[PRIMARY.name],BASE,monthly_days)[2]}
                 for chain in chains if chain is not primary_chain]
        accepted = [row for row in signals[PRIMARY.name] if valid.index[0]<=row["decision"]<=valid.index[-1]]
        eligible_holdings = [{key:item[key] for key in ("period_end","disclosed_on","source","evidence_level")}
                             for item in holdings["reports"] if code in item["share_codes"]
                             and item["disclosed_on"]<latest]
        report[code] = {"status":"research_backtest","name":fund["name"],"start":dateonly(valid.index[0]),
                        "end":dateonly(valid.index[-1]),"non_session_nav":sum(
                            start<=row["date"]<=latest and pd.Timestamp(row["date"]) not in sessions for row in fund["rows"]),
                        "missing_oos_levels":int(levels.loc[OOS_START:].isna().sum()),"rows":len(valid),
                        "holdings_disclosures":eligible_holdings,"holdings_used_in_signals":False,
                        "main":results,"regimes":regime_summaries(paths,trades,phased),
                        "cost_sensitivity":costs,"signal_sensitivity":variations,"other_chains":other,
                        "decision_count":len(accepted),"sector_signal_count":sum(bool(row["sectors"]) for row in accepted),
                        "sector_target_diff_count":sum(row["targets"]["B"]!=row["targets"]["C"] for row in accepted),
                        "selected_sectors":sorted({item["code"] for row in accepted for item in row["sectors"]})}
        if code in CASES:
            report[code]["case"] = summarize_cases(valid,trades,results,signals[PRIMARY.name])
            if charts:
                chart_case(code,valid,paths,results,signals[PRIMARY.name],trades,charts)
    return {"schema_version":1,"data":data_report,"status":"assumed_availability_and_execution",
            "out_of_sample_start":OOS_START,"baseline":asdict(PRIMARY),"execution":asdict(BASE),
            "signals":[asdict(rule) for rule in RULES],"cost_assumptions":[asdict(case) for case in EXECUTIONS],
            "markets":controls,"candidates":sectors,"funds":report}


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--start",default="2021-01-04")
    parser.add_argument("--end",default=datetime.now(funds.SHANGHAI).date().isoformat())
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--charts",type=Path)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--public-probe",action="store_true")
    source.add_argument("--local-dir",type=Path)
    args = parser.parse_args()
    inputs = collect(args.start,args.end) if args.public_probe else load_local(args.local_dir,args.start,args.end)
    result = run_study(*inputs,args.start,args.end,args.charts)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False)+"\n",encoding="utf-8")
    print("Research results:",sum(fund["status"]=="research_backtest" for fund in result["funds"].values()))


if __name__ == "__main__":
    main()
