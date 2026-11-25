"""Cash-flow simulation and trend-participation metrics for mutual fund research."""
from collections import deque
from dataclasses import dataclass

import numpy as np
import pandas as pd

STRATEGIES = ("A","B","C","D","E")
OOS_START = "2023-01-03"
MIN_SEGMENT = 126
EPSILON = 1e-10


@dataclass(frozen=True)
class Execution:
    name: str
    order_delay: int = 1
    settlement: int = 3
    confirmation: int = 1
    subscription: float = .0015
    redemption: float = .005
    short_redemption: float = .015
    annual_cash: float = 0.0


BASE = Execution("base")
EXECUTIONS = (
    BASE, Execution("low_fee",subscription=.0008,redemption=0),
    Execution("high_fee",subscription=.015,redemption=.0075),
    Execution("slow_execution",order_delay=3,settlement=5),
    Execution("cash_yield",annual_cash=.015),
)


def segments(levels,start=OOS_START):
    """Retain separate verified chains rather than assume movement across gaps."""
    valid = levels.loc[start:].notna()
    return [index.index for _,index in valid[valid].groupby(valid.ne(valid.shift()).cumsum())
            if len(index)>=MIN_SEGMENT]


def order_schedule(sessions, decisions, strategy, execution, monthly_days, calendar=None):
    orders = {}
    first, last = sessions[0], sessions[-1]
    def enact(day,target,signal=None):
        idx = sessions.searchsorted(day)
        if idx<len(sessions):
            orders[idx] = (float(target),signal)
    calendar = sessions if calendar is None else calendar
    if strategy=="A":
        enact(first,1)
    elif strategy=="E":
        enact(first,.5)
        for day in monthly_days[(monthly_days>=first)&(monthly_days<last)]:
            idx = sessions.searchsorted(day)+execution.order_delay
            if idx<len(sessions):
                enact(sessions[idx],.5,day)
    else:
        earlier = [row for row in decisions if row["decision"]<first]
        previous = None
        if earlier:
            carried = earlier[-1]
            due = calendar.searchsorted(carried["decision"])+execution.order_delay
            if due<len(calendar):
                previous = carried["targets"][strategy]
                enact(max(first,calendar[due]),previous,carried["decision"])
        for row in decisions:
            day = row["decision"]
            target = row["targets"][strategy]
            if day<first or day>=last or target==previous:
                continue
            due = sessions.searchsorted(day)+execution.order_delay
            if due<len(sessions):
                enact(sessions[due],target,day)
            previous = target
    return orders


def simulation(levels, calendar, orders, execution, restrictions=None):
    """Mark total-return exposure separately from settled cash and sale receivables.

    Model lots are accrued exposure values. They support FIFO fee ages without
    claiming actual NAV share rounding or a verified distributor fill.
    """
    restrictions = restrictions or {}
    lots, receivables = deque(), deque()
    cash, fee_total = 1.0, 0.0
    balances, exposure, record, new_orders = [], [], [], deque()
    dates = levels.index
    target = 0
    for i,(day,level) in enumerate(levels.items()):
        if i:
            multiplier = level/levels.iloc[i-1]
            for lot in lots:
                lot[0] *= multiplier
            cash *= (1+execution.annual_cash)**((day-dates[i-1]).days/365.25)
        while receivables and receivables[0][0]<=i:
            cash += receivables.popleft()[1]
        if i in orders:
            new_orders.clear()
            new_orders.append(orders[i])
        risk = sum(lot[0] for lot in lots)
        total = cash+risk+sum(row[1] for row in receivables)
        if new_orders:
            target, signal = new_orders[0]
            delta = target*total-risk
            side = "buy" if delta>0 else "sell"
            allowed = restrictions.get(day,{})
            if abs(delta)<.01*total:
                new_orders.clear()
            elif not allowed.get(f"{side}_blocked"):
                fee = 0.0
                traded = 0.0
                holding_value_days = 0.0
                if side=="buy":
                    traded = min(delta/(1+target*execution.subscription), cash/(1+execution.subscription))
                    if traded>EPSILON:
                        fee = traded*execution.subscription
                        cash -= traded+fee
                        confirm_pos = min(calendar.searchsorted(day)+execution.confirmation,len(calendar)-1)
                        lots.append([traded,calendar[confirm_pos]])
                    if delta-traded<.01*total or not receivables:
                        new_orders.clear()
                else:
                    redeem = min(-delta,risk)
                    confirm_pos = min(calendar.searchsorted(day)+execution.confirmation,len(calendar)-1)
                    sale_confirm = calendar[confirm_pos]
                    while lots and redeem>EPSILON:
                        lot = lots[0]
                        if lot[1]>day:
                            break
                        age = (sale_confirm-lot[1]).days
                        quantity = min(lot[0],redeem)
                        rate = execution.short_redemption if age<7 else execution.redemption
                        fee += quantity*rate
                        holding_value_days += quantity*age
                        traded += quantity
                        lot[0] -= quantity
                        redeem -= quantity
                        if lot[0]<=EPSILON:
                            lots.popleft()
                    if traded>EPSILON:
                        receivables.append((i+execution.settlement,traded-fee))
                    if redeem<=EPSILON:
                        new_orders.clear()
                if traded>EPSILON:
                    fee_total += fee
                    record.append({"date":day,"signal":signal,"side":side,"gross":traded,"fee":fee,
                                   "turnover":traded/total, "holding_value_days":holding_value_days,
                                   "target":target})
        risk = sum(lot[0] for lot in lots)
        pending = sum(row[1] for row in receivables)
        total = risk+pending+cash
        balances.append(total)
        exposure.append((risk/total,cash/total,pending/total))
    result = pd.DataFrame(exposure,index=dates,columns=["risk","cash","unsettled"])
    result["value"] = balances
    return result,record,fee_total


def historical_phases(levels):
    """Disjoint hindsight windows describe outcomes only; signals never see them."""
    windows = []
    for i in range(0,len(levels)-63,63):
        first,end = levels.index[i],levels.index[i+63]
        change = levels.iloc[i+63]/levels.iloc[i]-1
        phase = "up" if change>=.10 else "down" if change<=-.10 else "neutral"
        windows.append((first,end,phase,change))
    return windows


def drawdown_metrics(value):
    peak = value.cummax().clip(lower=1)
    drawdown = value.div(peak)-1
    trough = drawdown.idxmin()
    start, longest, worst = value.index[0], 0, None
    under = False
    ongoing = None
    for day,change in drawdown.items():
        if change<-EPSILON:
            under = True
            duration = (day-start).days
            longest = max(longest,duration)
            if day==trough:
                worst = {"start":start.date().isoformat(),"trough":day.date().isoformat(),"recovery":None}
            ongoing = start.date().isoformat()
        else:
            if under:
                longest = max(longest,(day-start).days)
                if worst and worst["recovery"] is None and day>trough:
                    worst["recovery"] = day.date().isoformat()
            start, under, ongoing = day,False,None
    return drawdown,{"mdd":float(drawdown.min()),"max_drawdown_window":worst,
                     "longest_underwater_days":longest,"ongoing_since":ongoing,
                     "ongoing_days":(value.index[-1]-start).days if under else 0}


def metrics(path,record,fees,phases):
    years = (path.index[-1]-path.index[0]).days/365.25
    growth = float(path.value.iloc[-1]**(1/years)-1)
    dd, info = drawdown_metrics(path.value)
    stages = {}
    for p in ("up","neutral","down"):
        outcomes = [(left,right,market) for left,right,tag,market in phases if tag==p]
        if not outcomes:
            continue
        observed = [float(path.value.loc[right]/path.value.loc[left]-1) for left,right,_ in outcomes]
        benchmark = sum(market for _,_,market in outcomes)
        stages[p] = {"count":len(outcomes),"mean_risk":float(np.mean([
            path.risk.loc[left:right].iloc[:-1].mean() for left,right,_ in outcomes])),
            "mean_window_return":float(np.mean(observed)),"mean_fund_window_return":benchmark/len(observed),
            "capture":float(sum(observed)/benchmark) if abs(benchmark)>EPSILON else None,
            "missed_positive_return_points":float(sum(max(0,market-ret)
                                                       for (_,_,market),ret in zip(outcomes,observed) if market>0))}
    dd_day = dd.idxmin()
    peak_loss_phase = next((phase for left,right,phase,_ in phases if left<dd_day<=right),None)
    sold = sum(row["gross"] for row in record if row["side"]=="sell")
    return {"cagr":growth,"ending_value":float(path.value.iloc[-1]),**info,
            "calmar":growth/abs(info["mdd"]) if info["mdd"]<-EPSILON else None,
            "mdd_phase":peak_loss_phase,"adjustments":len(record),
            "annual_gross_turnover":sum(row["turnover"] for row in record)/years,
            "sold_weighted_holding_days":sum(row["holding_value_days"] for row in record)/sold if sold else None,
            "mean_risk":float(path.risk.mean()),"mean_cash":float(path.cash.mean()),
            "mean_unsettled":float(path.unsettled.mean()),"fee_paid_units":fees,"phases":stages}


def run_strategies(levels, calendar, decisions, execution, monthly_days, restrictions=None):
    phases = historical_phases(levels)
    paths, outcomes, trades = {}, {}, {}
    for name in STRATEGIES:
        orders = order_schedule(levels.index,decisions,name,execution,monthly_days,calendar)
        path,record,fees = simulation(levels,calendar,orders,execution,restrictions)
        paths[name],trades[name] = path,record
        outcomes[name] = metrics(path,record,fees,phases)
    return paths,trades,outcomes


def regime_summaries(paths,trades,phases):
    ranges = (("2023–2024","2023-01-03","2024-12-31"),("2025–2026","2025-01-01","2026-12-31"))
    result = {}
    for name,start,end in ranges:
        rows = {}
        for key,path in paths.items():
            subset = path.loc[start:end].copy()
            if len(subset)<MIN_SEGMENT:
                continue
            subset["value"] /= subset.value.iloc[0]
            record = [row for row in trades[key] if subset.index[0]<row["date"]<=subset.index[-1]]
            eligible = [item for item in phases if subset.index[0]<=item[0] and item[1]<=subset.index[-1]]
            rows[key] = metrics(subset,record,sum(row["fee"] for row in record),eligible)
        if rows:
            result[name] = rows
    return result
