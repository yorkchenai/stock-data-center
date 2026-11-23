"""Flow-adjusted fund returns, market-controlled exposure and rolling sector rankings."""
from dataclasses import dataclass
from math import ceil

import numpy as np
import pandas as pd

WINDOWS = (20, 60, 120)
FUND = "__fund__"
METHODS = ("ols", "ridge", "elastic_net")
MIN_SECTORS = 3
MIN_TRAIN = 200
MARKET_NEAR_DUPLICATE = .90


def session_levels(values, sessions):
    """Align levels to the full declared calendar without filling open sessions."""
    series = pd.Series(values, dtype=float)
    series.index = pd.DatetimeIndex(pd.to_datetime(series.index, errors="raise"))
    if series.index.has_duplicates:
        raise ValueError("Duplicate valuation dates")
    non_session = series.index.difference(sessions)
    if len(non_session):
        raise ValueError("Observations outside the declared session calendar")
    return series.where(np.isfinite(series) & (series > 0)).reindex(sessions)


def fund_levels(fund, sessions):
    if fund["valuation_frequency"] != "daily" or fund["category"] not in {"stock","mixed","index"}:
        raise ValueError("unsupported_fund_frequency_or_type")
    if fund.get("return_basis") not in {"event_reinvested","adjusted_nav"}:
        raise ValueError("unsupported_total_return_basis")
    rows = [row for row in fund["rows"] if sessions[0] <= pd.Timestamp(row["date"]) <= sessions[-1]]
    levels = {row["date"]:row["return_index"] if not row.get("return_issue") else None for row in rows}
    if len(levels) != len(rows):
        raise ValueError("Duplicate fund valuation dates")
    return session_levels(levels,sessions)


def daily_returns(levels):
    return levels.div(levels.shift()) - 1


def alignment(fund, histories, sessions):
    funds_wide = fund_levels(fund,sessions)
    levels = {FUND:funds_wide}
    for code,frame in histories.items():
        levels[code] = session_levels(frame.close, sessions)
    return pd.DataFrame({code:daily_returns(series) for code,series in levels.items()})


def residuals(values, factors):
    x = np.column_stack((np.ones(len(factors)), factors))
    return values - x @ np.linalg.lstsq(x, values, rcond=None)[0]


def correlation(a, b):
    scale_a, scale_b = np.std(a), np.std(b)
    if min(scale_a, scale_b) < 1e-10:
        return None
    return float(np.corrcoef(a,b)[0,1])


def observed_window(frame, size):
    # Limit the age of the time window even when many daily observations are missing.
    recent = frame.tail(ceil(size * 1.25))
    aligned = recent.dropna().tail(size)
    gaps = int(recent.isna().any(axis=1).sum())
    return aligned, gaps


def correlations(frame, sector, markets, size):
    pair, pair_gaps = observed_window(frame[[FUND, sector]], size)
    common, common_gaps = observed_window(frame[[FUND, sector, *markets]], size)
    market_rank = np.linalg.matrix_rank(np.column_stack((np.ones(len(common)), common[markets]))) if len(common) else 0
    return {
        "count":len(pair), "first":pair.index[0].date().isoformat() if len(pair) else None,
        "last":pair.index[-1].date().isoformat() if len(pair) else None,
        "missing_in_lookback":pair_gaps,
        "pearson":correlation(pair[FUND], pair[sector]) if len(pair)==size else None,
        "partial_count":len(common), "partial_missing_in_lookback":common_gaps,
        "partial_first":common.index[0].date().isoformat() if len(common) else None,
        "partial_last":common.index[-1].date().isoformat() if len(common) else None,
        "partial":correlation(residuals(common[FUND],common[markets]), residuals(common[sector],common[markets]))
        if markets and len(common)==size and market_rank == len(markets)+1 else None,
    }


@dataclass(frozen=True)
class Fit:
    intercept: float
    slopes: np.ndarray
    condition: float | None

    def predict(self, x):
        return self.intercept + np.asarray(x) @ self.slopes


def elastic_coefficients(x, y):
    penalty, ratio = .10, .5
    beta = np.zeros(x.shape[1])
    residual = y.copy()
    squares = (x*x).mean(axis=0)
    for _ in range(3000):
        max_change = 0.0
        for i, column in enumerate(x.T):
            residual += beta[i] * column
            dot = float(np.mean(residual * column))
            value = np.sign(dot) * max(abs(dot) - penalty*ratio, 0) / (squares[i] + penalty*(1-ratio))
            residual -= value * column
            max_change = max(max_change, abs(value-beta[i]))
            beta[i] = value
        if max_change < 1e-8:
            return beta
    raise ValueError("elastic_net_did_not_converge")


def fit_model(method, x, y):
    x, y = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    if x.ndim != 2 or x.shape[1] < 1 or len(x) < x.shape[1]+2 or y.shape != (len(x),):
        raise ValueError("insufficient_regression_sample")
    if not np.isfinite(x).all() or not np.isfinite(y).all():
        raise ValueError("nonfinite_regression_inputs")
    mean, spread = x.mean(axis=0), x.std(axis=0)
    spread = np.where(spread > 1e-12,spread,1)
    design = (x - mean)/spread
    centered = y-y.mean()
    condition = float(np.linalg.cond(design))
    if method == "ols":
        normalized = np.linalg.lstsq(design, centered, rcond=None)[0]
    elif method == "ridge":
        n, k = design.shape
        normalized = np.linalg.solve(design.T@design/n + .10*np.eye(k), design.T@centered/n)
    elif method == "elastic_net":
        scale = max(1e-12, float(y.std()))
        normalized = elastic_coefficients(design,centered/scale)*scale
    else:
        raise ValueError("unknown_regression_model")
    slopes = normalized / spread
    return Fit(float(y.mean()-mean @ slopes),slopes,condition if np.isfinite(condition) else None)


def r_squared(actual, predicted):
    actual, predicted = np.asarray(actual), np.asarray(predicted)
    total = ((actual-actual.mean())**2).sum()
    return float(1-((actual-predicted)**2).sum()/total) if total > 1e-15 else None


def remove_redundancy(scored, returns, markets):
    chosen = []
    for code in scored:
        redundant = False
        for prior in chosen:
            common = returns[[code,prior,*markets]].tail(150).dropna()
            if len(common)>=60:
                left = residuals(common[code],common[markets])
                right = residuals(common[prior],common[markets])
                strength = correlation(left,right)
                if strength is not None and abs(strength)>=MARKET_NEAR_DUPLICATE:
                    redundant = True
                    break
        if not redundant:
            chosen.append(code)
    return chosen


def screen(returns, candidates, markets):
    report, scores = {}, {}
    for code in candidates:
        stats = {size:correlations(returns,code,markets,size) for size in WINDOWS}
        report[code] = {"windows":stats}
        short, long = stats[60], stats[120]
        if (short["partial"] is not None and short["partial"]>=.10
                and long["partial"] is not None and long["partial"]>=.10
                and short["pearson"] is not None and short["pearson"]>=.30
                and long["pearson"] is not None and long["pearson"]>=.30
                and short["partial_last"] == returns.index[-1].date().isoformat()):
            scores[code] = (.35*short["partial"]+.35*long["partial"]
                            +.15*short["pearson"]+.15*long["pearson"])
            report[code]["score"] = scores[code]
    order = sorted(scores,key=lambda code:(-scores[code],code))
    return report, remove_redundancy(order,returns,markets)[:8]


def exposure_models(returns, candidates, markets):
    keys = [*markets,*candidates]
    recent, _ = observed_window(returns[[FUND,*keys]],120)
    if len(recent)!=120:
        return {}
    x, y = recent[keys], recent[FUND]
    models = {}
    for method in METHODS:
        fit = fit_model(method,x,y)
        rolled = []
        for offset in (40,20,0):
            sample = returns.iloc[:len(returns)-offset] if offset else returns
            block, _ = observed_window(sample[[FUND,*keys]], 100)
            if len(block)==100:
                rolled.append(fit_model(method,block[keys],block[FUND]).slopes)
        models[method] = {
            "n":len(recent), "first":recent.index[0].date().isoformat(), "last":recent.index[-1].date().isoformat(),
            "condition":fit.condition, "intercept":fit.intercept,
            "in_sample_r2":r_squared(y,fit.predict(x)),
            "residual_daily_std":float(np.std(y-fit.predict(x),ddof=1)),
            "betas":dict(zip(keys,map(float,fit.slopes))),
            "positive_fraction":dict(zip(keys,map(float,(np.array(rolled)>0).mean(axis=0)))) if rolled else {},
            "beta_range":{key:[float(min(column)),float(max(column))]
                          for key,column in zip(keys,np.array(rolled).T)} if rolled else {},
            "stability_windows":len(rolled),
        }
    return models


def rank_associations(returns, candidates, markets, holdings_groups=None, keep_profiles=True):
    returns = returns.loc[:returns[FUND].last_valid_index()] if returns[FUND].notna().any() else returns.iloc[:0]
    if len(returns) < 120 or not markets or len(candidates)<MIN_SECTORS:
        return {"status":"insufficient_coverage","ranked":[],"profiles":{},"models":{}}
    profiles, shortlisted = screen(returns,candidates,markets)
    models = exposure_models(returns,shortlisted,markets)
    ridge = models.get("ridge",{})
    ranked = []
    for code in shortlisted:
        beta = ridge.get("betas",{}).get(code)
        stability = ridge.get("positive_fraction",{}).get(code)
        if beta is None or beta < .05 or stability is None or stability < 2/3 or ridge["stability_windows"]<2:
            continue
        evidence = (holdings_groups or {}).get(code)
        score = profiles[code]["score"] + (.02 if evidence and evidence.get("supportible") else 0)
        ranked.append({"code":code,"beta":beta,"positive_fraction":stability,
                       "beta_range":ridge["beta_range"].get(code),"windows":profiles[code]["windows"],
                       "holdings_evidence":evidence,
                       "quality":"strong" if stability==1 and profiles[code]["windows"][120]["partial"]>=.25
                       else "moderate","score":score})
    ranked.sort(key=lambda row:(-row["score"],row["code"]))
    return {"status":"ok" if ranked else "no_reliable_association","ranked":ranked[:5],
            "profiles":profiles if keep_profiles else {},"models":models,
            "as_of":returns.index[-1].date().isoformat()}
