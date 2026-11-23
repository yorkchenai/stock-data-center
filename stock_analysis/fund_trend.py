"""Point-in-time fund trend signals and historical sector confirmation."""
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .indicators import directional_indicators, price_indicators
from .sector_model import FUND, daily_returns, rank_associations
from .sector_signals import valid_runs
from .sector_validation import DATA_LAG, TRAIN_WINDOW

UP, NEUTRAL, DOWN = "uptrend", "neutral", "downtrend"
TARGETS = {UP: 1.0, NEUTRAL: .5, DOWN: 0.0}


@dataclass(frozen=True)
class SignalRule:
    name: str
    frequency: str = "weekly"
    sampling: str = "weekly"
    short: int = 12
    long: int = 26
    availability: int = DATA_LAG
    confirmation: int = 2
    weighting: str = "weighted"
    drop_top: bool = False


PRIMARY = SignalRule("weekly")
RULES = (
    PRIMARY, SignalRule("monthly", frequency="monthly"),
    SignalRule("daily_weekly", sampling="daily", short=60, long=120),
    SignalRule("faster", short=8, long=20), SignalRule("slower", short=16, long=32),
    SignalRule("publication_lag", availability=4), SignalRule("vote", weighting="vote"),
    SignalRule("drop_top_sector", drop_top=True),
)


def complete_periods(sessions, frequency):
    """Use the last session of fully known weeks/months from a padded calendar."""
    period = sessions.to_period("W-FRI" if frequency == "weekly" else "M")
    return sessions[~period.duplicated(keep="last")]


def bars_from_history(levels, sessions, rule, frame=None):
    """Compute weekly observations from trading calendars and original prices."""
    daily = pd.DataFrame({"close":levels.reindex(sessions)},index=sessions)
    if frame is not None and {"open","high","low"}.issubset(frame.columns):
        daily[["open","high","low"]] = frame[["open","high","low"]].reindex(sessions)
    if rule.sampling=="daily":
        return daily
    grouped = daily.groupby(sessions.to_period("W-FRI"))
    close = grouped.close.last().where(grouped.close.count()==grouped.size())
    bars = pd.DataFrame({"close":close})
    if {"open","high","low"}.issubset(daily):
        for name, method in {"open":"first","high":"max","low":"min"}.items():
            bars[name] = grouped[name].agg(method).where(grouped[name].count()==grouped.size())
    bars.index = complete_periods(sessions,"weekly")
    return bars


def trend_series(levels, sessions, rule, frame=None):
    bars = bars_from_history(levels,sessions,rule,frame)
    result = pd.DataFrame(index=bars.index,columns=["state","MA20","MA60","MA120","short_slope","long_slope",
                                                    "movement_short","movement_long","MACD","RSI14","ADX14",
                                                    "rolling_drawdown","volatility"],dtype=object)
    present = bars.close.notna()
    for _, block in bars.loc[present].groupby(valid_runs(present)):
        close = block.close
        short, long = rule.short, rule.long
        short_ma, long_ma = close.rolling(short).mean(), close.rolling(long).mean()
        slope_length, momentum_short, momentum_long = (4,4,12) if rule.sampling=="weekly" else (20,20,60)
        fast_slope, slow_slope = short_ma.pct_change(slope_length), long_ma.pct_change(slope_length)
        fast_momentum, slow_momentum = close.pct_change(momentum_short), close.pct_change(momentum_long)
        # Only sustained price/average/long-momentum alignment changes the direction.
        ready = pd.concat([short_ma,long_ma,fast_slope,slow_slope,slow_momentum],axis=1).notna().all(axis=1)
        up = (close>long_ma)&(short_ma>long_ma)&(fast_slope>0)&(slow_slope>0)&(slow_momentum>0)
        down = (close<long_ma)&(short_ma<long_ma)&(fast_slope<0)&(slow_slope<0)&(slow_momentum<0)
        indicators = price_indicators(close)
        features = {"state":pd.Series(np.select([up,down],[UP,DOWN],default=NEUTRAL),index=close.index).where(ready),
                    "MA20":close.rolling(4 if rule.sampling=="weekly" else 20).mean(),
                    "MA60":close.rolling(12 if rule.sampling=="weekly" else 60).mean(),
                    "MA120":close.rolling(26 if rule.sampling=="weekly" else 120).mean(),
                    "short_slope":fast_slope,"long_slope":slow_slope,
                    "movement_short":fast_momentum,"movement_long":slow_momentum,
                    "MACD":indicators.MACD_hist,"RSI14":indicators.RSI14,
                    "rolling_drawdown":close.div(close.rolling(long).max())-1,
                    "volatility":close.pct_change().rolling(momentum_short).std()*np.sqrt(52 if rule.sampling=="weekly" else 252)}
        result.loc[close.index,list(features)] = pd.DataFrame(features)
    if {"open","high","low"}.issubset(bars):
        full = bars[["open","high","low","close"]].notna().all(axis=1)
        for _, block in bars.loc[full].groupby(valid_runs(full)):
            result.loc[block.index,"ADX14"] = directional_indicators(block).ADX14
    return result


def known_state(table, cutoff, sampling):
    prior = table.loc[:cutoff]
    if prior.empty:
        return None
    day = prior.index[-1]
    state = prior.loc[day,"state"]
    if pd.isna(state) or (cutoff-day).days > (10 if sampling=="weekly" else 0):
        return None
    return state


def combine(rows, weighting):
    if not rows:
        return None, []
    weights = np.array([max(.001,r["score"]) if weighting=="weighted" else 1.0 for r in rows])
    weights /= weights.sum()
    total_by_state = {state:sum(weight for row,weight in zip(rows,weights) if row["state"]==state)
                      for state in (UP,DOWN)}
    majority = UP if total_by_state[UP]>.5+1e-10 else DOWN if total_by_state[DOWN]>.5+1e-10 else NEUTRAL
    return majority, [{**row,"weight":float(weight)} for row,weight in zip(rows,weights)]


def joint_target(fund, sector):
    if sector is None:
        return TARGETS[fund]
    if fund==UP:
        return .5 if sector==DOWN else 1
    if fund==DOWN:
        return .5 if sector==UP else 0
    return .5


class Confirmation:
    """Require consecutive targets before changing exposure."""
    def __init__(self, periods):
        self.periods = periods
        self.target = .5
        self.previous = None
        self.count = 0

    def update(self,target):
        self.count = self.count+1 if target==self.previous else 1
        self.previous = target
        if self.count>=self.periods and target is not None:
            self.target = target
        return self.target


def historical_selector(returns, controls, sectors):
    cache = {}

    def select(cutoff):
        if cutoff not in cache:
            history = returns.loc[:cutoff].tail(TRAIN_WINDOW)
            if history.empty or pd.isna(history[FUND].iloc[-1]):
                cache[cutoff] = []
            else:
                complete = [key for key in controls if history[key].tail(150).notna().sum()>=120]
                result = rank_associations(history,sectors,complete, keep_profiles=False)
                cache[cutoff] = [{"code":row["code"],"score":row["score"]} for row in result["ranked"]]
        return cache[cutoff]

    return select


def decisions(fund_states, sector_states, sessions, simulation_end, rule, select):
    trades = complete_periods(sessions,rule.frequency)
    confirm = {name:Confirmation(rule.confirmation) for name in ("B","C","D")}
    output = []
    ranking = []
    ranking_month = None
    rank_cutoff = None
    for day in trades[trades<=simulation_end]:
        offset = sessions.get_loc(day)-rule.availability
        if offset<0:
            continue
        cutoff = sessions[offset]
        fund = known_state(fund_states,cutoff,rule.sampling)
        month = cutoff.to_period("M")
        if month!=ranking_month:
            ranking_month = month
            ranking = select(cutoff)
            rank_cutoff = cutoff
        active = ranking[1:] if rule.drop_top else ranking
        observed = []
        for item in active:
            code = item["code"]
            state = known_state(sector_states[code],cutoff,rule.sampling)
            if state:
                observed.append({**item,"state":state})
        sector, weighted = combine(observed,rule.weighting)
        own = TARGETS.get(fund)
        own_weight = confirm["B"].update(own)
        joint = confirm["C"].update(joint_target(fund,sector) if fund else None)
        sector_weight = confirm["D"].update(TARGETS.get(sector,.5))
        output.append({"decision":day,"known_through":cutoff,"ranked_through":rank_cutoff,
                       "fund_state":fund,"sector_state":sector,"sectors":weighted,
                       "targets":{"B":own_weight,"C":joint,"D":sector_weight}})
    return output


def market_returns(nav, index_levels):
    return pd.DataFrame({FUND:daily_returns(nav), **{key:daily_returns(value)
                                                    for key,value in index_levels.items()}})
