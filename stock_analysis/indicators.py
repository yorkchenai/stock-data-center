"""Wilder RSI/ADX and recursive EMA, extracted from the original chart script."""
import numpy as np
import pandas as pd

from .validation import normalize_daily


def rsi_wilder(close, period):
    delta = close.diff()
    gains = delta.clip(lower=0)
    losses = -delta.clip(upper=0)
    avg_gain = pd.Series(np.nan, index=close.index, dtype=float)
    avg_loss = pd.Series(np.nan, index=close.index, dtype=float)
    if len(close) <= period:
        return avg_gain
    avg_gain.iloc[period] = gains.iloc[1:period + 1].mean()
    avg_loss.iloc[period] = losses.iloc[1:period + 1].mean()
    for i in range(period + 1, len(close)):
        avg_gain.iloc[i] = (avg_gain.iloc[i - 1] * (period - 1) + gains.iloc[i]) / period
        avg_loss.iloc[i] = (avg_loss.iloc[i - 1] * (period - 1) + losses.iloc[i]) / period
    denominator = avg_gain + avg_loss
    return (100 * avg_gain / denominator).where(denominator != 0, 50)


def wilder_sum(values, period):
    smoothed = pd.Series(np.nan, index=values.index, dtype=float)
    if len(values) <= period:
        return smoothed
    smoothed.iloc[period] = values.iloc[1:period + 1].sum()
    for i in range(period + 1, len(values)):
        smoothed.iloc[i] = smoothed.iloc[i - 1] * (period - 1) / period + values.iloc[i]
    return smoothed


def calculate_indicators(frame):
    """Return daily inputs and indicators. Initial undefined values remain NaN."""
    df = normalize_daily(frame)
    df["change_pct"] = df.close.pct_change(fill_method=None) * 100
    for period in [5, 10, 20, 60]:
        df[f"MA{period}"] = df.close.rolling(period, min_periods=period).mean()
    for period in [5, 10]:
        df[f"VOL{period}"] = df.volume_lots.rolling(period, min_periods=period).mean()
        df[f"VMA{period}"] = df[f"VOL{period}"]  # Preserve the original CSV column names.

    df["EMA12"] = df.close.ewm(span=12, adjust=False).mean()
    df["EMA26"] = df.close.ewm(span=26, adjust=False).mean()
    df["DIF"] = df.EMA12 - df.EMA26
    df["DEA"] = df.DIF.ewm(span=9, adjust=False).mean()
    df["MACD_hist"] = 2 * (df.DIF - df.DEA)
    for period in [6, 12, 14, 24]:
        df[f"RSI{period}"] = rsi_wilder(df.close, period)

    up = df.high.diff()
    down = -df.low.diff()
    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=df.index)
    true_range = pd.concat([
        df.high - df.low,
        (df.high - df.close.shift()).abs(),
        (df.low - df.close.shift()).abs(),
    ], axis=1).max(axis=1)
    period = 14
    range_sum = wilder_sum(true_range, period)
    df["+DI"] = (100 * wilder_sum(plus_dm, period) / range_sum.replace(0, np.nan)).mask(range_sum == 0, 0)
    df["-DI"] = (100 * wilder_sum(minus_dm, period) / range_sum.replace(0, np.nan)).mask(range_sum == 0, 0)
    di_sum = df["+DI"] + df["-DI"]
    dx = (100 * (df["+DI"] - df["-DI"]).abs() / di_sum.replace(0, np.nan)).mask(di_sum == 0, 0)
    adx = pd.Series(np.nan, index=df.index, dtype=float)
    if len(df) >= 2 * period:
        adx.iloc[2 * period - 1] = dx.iloc[period:2 * period].mean()
    for i in range(2 * period, len(df)):
        adx.iloc[i] = (adx.iloc[i - 1] * (period - 1) + dx.iloc[i]) / period
    df["ADX14"] = adx
    return df
