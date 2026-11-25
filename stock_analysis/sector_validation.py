"""Forward evaluation of fund-only, market and sector-enhanced predictors."""
from math import erfc, sqrt

import numpy as np
import pandas as pd

from .sector_model import FUND, METHODS, MIN_TRAIN, correlation, fit_model, rank_associations, r_squared

HORIZONS = (1,5,20)
DATA_LAG = 2
TARGET_START_LAG = 1
TEST_BLOCK = 63
TRAIN_WINDOW = 504


def future_return(fund_returns,horizon):
    # t+1 is the proposed valuation anchor, not an assumed execution NAV.
    future = (1+fund_returns).rolling(horizon).apply(np.prod,raw=True)-1
    return future.shift(-(TARGET_START_LAG+horizon))


def fund_features(returns):
    values = returns[FUND]
    return pd.DataFrame({"fund1":values, "fund5":(1+values).rolling(5).apply(np.prod,raw=True)-1,
                         "fund20":(1+values).rolling(20).apply(np.prod,raw=True)-1,
                         "fundvol20":values.rolling(20).std()})


def index_features(technical, codes):
    columns = ["ret5","ret20","ma20_distance","macd_normalized","rsi_centered"]
    return pd.concat([technical[code][columns].add_prefix(f"{code}_") for code in codes],axis=1)


def precision_metrics(actual, predicted):
    diff = actual-predicted
    return {
        "n":len(actual), "rmse":float(np.sqrt((diff**2).mean())), "mae":float(abs(diff).mean()),
        "direction_accuracy":float((np.sign(actual)==np.sign(predicted)).mean()),
        "rank_ic":correlation(actual.rank(),predicted.rank()), "r2":r_squared(actual,predicted),
    }


def paired_improvement(predictions, horizon):
    """Positive paired squared-loss difference favors C. HAC adjusts overlapping outcomes."""
    improvement = ((predictions.actual-predictions.B)**2-(predictions.actual-predictions.C)**2)
    n = len(improvement)
    if n<100:
        return {"status":"insufficient_sample"}
    # Use exchange session positions so gaps do not become adjacent observations.
    indexed = improvement.copy()
    indexed.index = predictions.session_position
    lag = max(20,horizon-1)
    centered = indexed-indexed.mean()
    variance = float((centered**2).mean())
    for offset in range(1,lag+1):
        past = centered.copy()
        past.index += offset
        covariance = float(centered.mul(past).sum()/n)
        variance += 2*(1-offset/(lag+1))*covariance
    mean = float(improvement.mean())
    if variance<=0:
        return {"status":"undefined_sampling_variance","mean_loss_improvement":mean}
    error = sqrt(variance/n)
    return {"status":"exploratory", "mean_loss_improvement":mean, "hac_lag":lag,
            "confidence_95":[mean-1.96*error,mean+1.96*error],
            "p_value":erfc(abs(mean/error)/sqrt(2))}


def make_fold(data, labels, regimes, position, horizon, feature_sets, outputs):
    evaluation = slice(position,min(position+TEST_BLOCK,len(data)))
    # A label matures at its endpoint plus the assumed publication lag.
    cutoff = position-TARGET_START_LAG-horizon-DATA_LAG-1
    train = data.iloc[max(0,cutoff-TRAIN_WINDOW+1):cutoff+1].dropna()
    test = data.iloc[evaluation].dropna()
    if len(train)<MIN_TRAIN or test.empty:
        return None
    target = train.actual
    for method in METHODS:
        out = test[["actual"]].copy()
        for label, names in feature_sets.items():
            fit = fit_model(method,train[names],target)
            out[label] = fit.predict(test[names])
        out["regime"] = regimes.loc[out.index]
        out["session_position"] = labels.loc[out.index]
        outputs[method][horizon].append(out)
    return {"first_prediction":test.index[0].date().isoformat(), "last_prediction":test.index[-1].date().isoformat(),
            "last_training_decision":train.index[-1].date().isoformat(),
            "last_training_label_matured_by":data.index[cutoff+TARGET_START_LAG+horizon+DATA_LAG].date().isoformat(),
            "observations":len(test),"training_rows":len(train)}



def explain_fold(returns, position, selection_cutoff, markets, sectors):
    names = [*markets,*sectors]
    aligned = returns[[FUND,*names]]
    train = aligned.iloc[max(0,selection_cutoff-TRAIN_WINDOW+1):selection_cutoff+1].dropna()
    test = aligned.iloc[position:position+TEST_BLOCK].dropna()
    if len(train)<120 or test.empty:
        return None
    output = pd.DataFrame({"actual":test[FUND]})
    for method in METHODS:
        output[method] = fit_model(method,train[names],train[FUND]).predict(test[names])
    return output

def walk_forward(returns, technical, markets, candidates):
    if not markets or not candidates or len(returns)<MIN_TRAIN+2:
        return {"status":"insufficient_coverage","models":{}}
    own = fund_features(returns)
    control = index_features(technical,markets)
    all_sectors = index_features(technical,candidates)
    targets = {h:future_return(returns[FUND],h) for h in HORIZONS}
    market_trend = technical[markets[0]].ret20.shift(DATA_LAG)
    stages = pd.Series(np.where(market_trend>=0,"rising","falling"),index=market_trend.index).where(market_trend.notna())
    positions = pd.Series(np.arange(len(returns)),index=returns.index)
    outputs = {method:{h:[] for h in HORIZONS} for method in METHODS}
    folds, explanations = [], []
    # Start relative to the fund's available observations. A young fund with
    # insufficient chronological training history stays unverified.
    available = np.flatnonzero(returns[FUND].notna())
    first_end = available[0]+MIN_TRAIN+max(HORIZONS)+DATA_LAG+25 if len(available) else len(returns)
    for position in range(first_end,len(returns)-TARGET_START_LAG,TEST_BLOCK):
        selection_cutoff = position-TARGET_START_LAG-max(HORIZONS)-DATA_LAG-1
        history = returns.iloc[max(0,selection_cutoff-TRAIN_WINDOW+1):selection_cutoff+1]
        selected = rank_associations(history,candidates,markets,keep_profiles=False)["ranked"]
        codes = [item["code"] for item in selected]
        if not codes:
            continue
        extra = all_sectors[[name for name in all_sectors if name.split("_",1)[0] in codes]]
        features = pd.concat([own,control,extra],axis=1).shift(DATA_LAG)
        fields = {"A":own.columns.tolist(),"B":[*own.columns,*control.columns],"C":features.columns.tolist()}
        horizons = {}
        for h in HORIZONS:
            joined = features.assign(actual=targets[h])
            entry = make_fold(joined,positions,stages,position,h,fields,outputs)
            if entry:
                horizons[h] = entry
        if horizons:
            explained = explain_fold(returns,position,selection_cutoff,markets,codes)
            if explained is not None:
                explanations.append(explained)
            folds.append({"selection_through":returns.index[selection_cutoff].date().isoformat(),
                          "selected":codes,"horizons":horizons})
    result = {}
    for method, groups in outputs.items():
        measures = {}
        for h, blocks in groups.items():
            if not blocks:
                continue
            predictions = pd.concat(blocks)
            comparisons = {name:precision_metrics(predictions.actual,predictions[name]) for name in ("A","B","C")}
            stages_result = {}
            for stage, subset in predictions.groupby("regime"):
                stages_result[stage] = {name:precision_metrics(subset.actual,subset[name]) for name in ("A","B","C")}
            measures[h] = {"models":comparisons,"market_stages":stages_result,
                           "sector_increment":paired_improvement(predictions,h),"test_blocks":len(blocks),
                           "first":predictions.index[0].date().isoformat(),"last":predictions.index[-1].date().isoformat()}
        result[method] = measures
    explanatory_oos = {}
    if explanations:
        same_day = pd.concat(explanations)
        explanatory_oos = {"n":len(same_day), "purpose":"contemporaneous_explanation",
                           "r2":{method:r_squared(same_day.actual,same_day[method]) for method in METHODS}}
    return {"status":"retrospective_assumed_availability" if folds else "insufficient_forward_folds",
            "models":result,"folds":folds,"contemporaneous_oos":explanatory_oos,"signal_delay_sessions":DATA_LAG,
            "target_anchor_delay_sessions":TARGET_START_LAG,"training_window_sessions":TRAIN_WINDOW}
