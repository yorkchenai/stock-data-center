"""Causal close and OHLC technical features. No synthetic volume or missing prices."""
import numpy as np
import pandas as pd

from .indicators import directional_indicators, price_indicators


def valid_runs(present):
    return present.astype(int).diff().fillna(0).ne(0).cumsum()


def technical_series(history, sessions, volume_unit=None):
    frame = history.reindex(sessions).copy()
    close_present = frame.close.notna()
    columns = ("change_pct","MA5","MA10","MA20","MA60","DIF","DEA","MACD_hist","RSI14",
               "ADX14","+DI","-DI","VOL5","VOL10","ret5","ret20","position120",
               "ma20_distance","macd_normalized","rsi_centered","ma20_change5")
    frame[list(columns)] = np.nan
    for _, block in frame.loc[close_present].groupby(valid_runs(close_present)):
        price = price_indicators(block.close)
        shared = list(set(price.columns).intersection(columns))
        price = price[shared]
        price["ret5"] = block.close.pct_change(5,fill_method=None)
        price["ret20"] = block.close.pct_change(20,fill_method=None)
        price["ma20_distance"] = block.close.div(price.MA20)-1
        price["macd_normalized"] = price.MACD_hist.div(block.close)
        price["ma20_change5"] = price.MA20.pct_change(5,fill_method=None)
        price["rsi_centered"] = (price.RSI14-50)/50
        price["position120"] = block.close.rolling(120).rank(pct=True)
        frame.loc[price.index,price.columns] = price
    if {"high","low","open"}.issubset(frame):
        has_ohlc = frame[["open","high","low","close"]].notna().all(axis=1)
        for _, block in frame.loc[has_ohlc].groupby(valid_runs(has_ohlc)):
            directional = directional_indicators(block)
            frame.loc[directional.index,directional.columns] = directional
    if volume_unit is not None and "volume" in frame:
        for period in (5,10):
            frame[f"VOL{period}"] = frame.volume.rolling(period).mean()
    return frame


def finite_or_none(value):
    return float(value) if np.isfinite(value) else None


def technical_snapshot(frame, as_of, volume_unit=None):
    clean = frame.loc[:as_of].dropna(subset=["close"])
    if clean.empty:
        return {"status":"unavailable"}
    day, last = clean.index[-1], clean.iloc[-1]
    ma = [finite_or_none(last[key]) for key in ("MA5","MA10","MA20","MA60")]
    arrangement = None
    if all(item is not None for item in ma):
        arrangement = "ascending_strength" if ma[0]>ma[1]>ma[2]>ma[3] else (
            "descending_strength" if ma[0]<ma[1]<ma[2]<ma[3] else "mixed")
    # Compare adjacent sessions only. Dropna is for finding the last price, not for lagging indicators.
    previous = frame.MACD_hist.shift().loc[day]
    prior_rsi = frame.RSI14.shift(5).loc[day]
    return {
        "status":"ok", "as_of":day.date().isoformat(),
        "layers":[
            {"layer":"价格定位置","close":float(last.close),"percentile_120":finite_or_none(last.position120),
             "return_20":finite_or_none(last.ret20)},
            {"layer":"均线判趋势","MA5":ma[0],"MA10":ma[1],"MA20":ma[2],"MA60":ma[3],
             "arrangement":arrangement,"MA20_change_5":finite_or_none(last.ma20_change5)},
            {"layer":"成交量看配合","status":"available" if volume_unit and pd.notna(last.get("volume")) else "unavailable",
             "unit":volume_unit,"volume":finite_or_none(last.volume) if volume_unit else None,
             "VOL5":finite_or_none(last.VOL5),"VOL10":finite_or_none(last.VOL10)},
            {"layer":"MACD看动量变化","DIF":finite_or_none(last.DIF),"DEA":finite_or_none(last.DEA),
             "hist":finite_or_none(last.MACD_hist),"hist_change":finite_or_none(last.MACD_hist-previous)},
            {"layer":"RSI看相对强弱","RSI14":finite_or_none(last.RSI14),
             "RSI14_change_5":finite_or_none(last.RSI14-prior_rsi)},
        ],
        "ADX":{"status":"available" if pd.notna(last.ADX14) else "unavailable",
               "ADX14":finite_or_none(last.ADX14),"+DI":finite_or_none(last["+DI"]),"-DI":finite_or_none(last["-DI"])},
    }
