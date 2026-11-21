"""Generate five separate technical-analysis charts from validated daily CSV."""
from pathlib import Path
import time
import json
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

start = time.perf_counter()
source = Path("results/000688_daily.csv")
out = Path("results/charts")
out.mkdir(parents=True, exist_ok=True)
df = pd.read_csv(source, parse_dates=["date"]).sort_values("date").reset_index(drop=True)
for name in ["open", "high", "low", "close", "volume_lots"]:
    df[name] = pd.to_numeric(df[name], errors="raise")
if len(df) < 100 or df[["open","high","low","close","volume_lots"]].isna().any().any():
    raise ValueError("Insufficient or invalid OHLCV data")

for n in [5, 10, 20, 60]:
    df[f"MA{n}"] = df.close.rolling(n, min_periods=n).mean()
for n in [5, 10]:
    df[f"VMA{n}"] = df.volume_lots.rolling(n, min_periods=n).mean()

ema12 = df.close.ewm(span=12, adjust=False).mean()
ema26 = df.close.ewm(span=26, adjust=False).mean()
df["DIF"] = ema12 - ema26
df["DEA"] = df.DIF.ewm(span=9, adjust=False).mean()
df["MACD_hist"] = 2 * (df.DIF - df.DEA)  # common Chinese-market convention

def rsi_wilder(close, n):
    delta = close.diff()
    gains = delta.clip(lower=0)
    losses = -delta.clip(upper=0)
    avg_gain = pd.Series(np.nan, index=close.index, dtype=float)
    avg_loss = pd.Series(np.nan, index=close.index, dtype=float)
    if len(close) <= n:
        return avg_gain
    avg_gain.iloc[n] = gains.iloc[1:n+1].mean()
    avg_loss.iloc[n] = losses.iloc[1:n+1].mean()
    for i in range(n+1, len(close)):
        avg_gain.iloc[i] = (avg_gain.iloc[i-1]*(n-1)+gains.iloc[i])/n
        avg_loss.iloc[i] = (avg_loss.iloc[i-1]*(n-1)+losses.iloc[i])/n
    denom = avg_gain + avg_loss
    return (100*avg_gain/denom).where(denom != 0, 50)
for n in [6, 14, 24]:
    df[f"RSI{n}"] = rsi_wilder(df.close, n)

up = df.high.diff()
down = -df.low.diff()
plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=df.index)
minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=df.index)
tr = pd.concat([df.high-df.low, (df.high-df.close.shift()).abs(), (df.low-df.close.shift()).abs()],axis=1).max(axis=1)
n = 14
def wilder_sum(s, period):
    z = pd.Series(np.nan, index=s.index, dtype=float)
    z.iloc[period] = s.iloc[1:period+1].sum()
    for i in range(period+1,len(s)):
        z.iloc[i] = z.iloc[i-1] - z.iloc[i-1]/period + s.iloc[i]
    return z
atr = wilder_sum(tr,n)
df["+DI"] = 100*wilder_sum(plus_dm,n)/atr.replace(0,np.nan)
df["-DI"] = 100*wilder_sum(minus_dm,n)/atr.replace(0,np.nan)
dx = 100*(df["+DI"]-df["-DI"]).abs()/(df["+DI"]+df["-DI"]).replace(0,np.nan)
adx = pd.Series(np.nan,index=df.index,dtype=float)
adx.iloc[2*n-1] = dx.iloc[n:2*n].mean()
for i in range(2*n,len(df)):
    adx.iloc[i] = (adx.iloc[i-1]*(n-1)+dx.iloc[i])/n
df["ADX14"] = adx

df.to_csv(out/"000688_indicators.csv",index=False,float_format="%.6f")
view = df.tail(120).copy().reset_index(drop=True)
x = np.arange(len(view))
tick = np.arange(0,len(view),max(1,len(view)//8))
def setup(title, ylabel):
    fig,ax=plt.subplots(figsize=(14,5.2),dpi=130)
    ax.set_title("STAR Market 50 (000688) | "+title,fontsize=14)
    ax.set_ylabel(ylabel)
    ax.set_xticks(tick)
    ax.set_xticklabels(view.date.dt.strftime("%Y-%m-%d").iloc[tick],rotation=25,ha="right")
    ax.grid(alpha=.18)
    return fig,ax
def save(fig,name):
    fig.tight_layout()
    fig.savefig(out/name,bbox_inches="tight")
    plt.close(fig)

fig,ax=setup("Price and moving averages","Index points")
for i,r in view.iterrows():
    col="#c0392b" if r.close>=r.open else "#198754"
    ax.vlines(i,r.low,r.high,color=col,lw=1)
    ax.vlines(i,min(r.open,r.close),max(r.open,r.close),color=col,lw=4)
for n in [5,10,20,60]:
    ax.plot(x,view[f"MA{n}"],label=f"MA{n}",lw=1.3)
ax.legend(ncol=4);save(fig,"01_price_ma.png")

fig,ax=setup("Volume and moving averages","100-share lots")
ax.bar(x,view.volume_lots,color=np.where(view.close>=view.open,"#c0392b","#198754"),alpha=.7)
for n in [5,10]:
    ax.plot(x,view[f"VMA{n}"],label=f"VMA{n}",lw=1.5)
ax.legend();save(fig,"02_volume_ma.png")

fig,ax=setup("MACD (12,26,9)","Index points")
ax.bar(x,view.MACD_hist,color=np.where(view.MACD_hist>=0,"#c0392b","#198754"),alpha=.6,label="2×(DIF−DEA)")
ax.plot(x,view.DIF,label="DIF",lw=1.4)
ax.plot(x,view.DEA,label="DEA",lw=1.4)
ax.axhline(0,color="black",lw=.8);ax.legend();save(fig,"03_macd.png")

fig,ax=setup("RSI (Wilder)","RSI")
for n in [6,14,24]:
    ax.plot(x,view[f"RSI{n}"],label=f"RSI{n}",lw=1.5)
for level in [30,50,70]:
    ax.axhline(level,color="gray",ls="--",lw=.8)
ax.set_ylim(0,100);ax.legend();save(fig,"04_rsi.png")

fig,ax=setup("ADX (14) and directional indicators","ADX / DI")
for name in ["ADX14","+DI","-DI"]:
    ax.plot(x,view[name],label=name,lw=1.5)
for level in [25,40]:
    ax.axhline(level,color="gray",ls="--",lw=.8)
ax.set_ylim(bottom=0);ax.legend();save(fig,"05_adx.png")

report={"status":"success","symbol":"000688","source_rows":len(df),"plotted_rows":len(view),
"first_plot_date":view.date.iloc[0].strftime("%Y-%m-%d"),"last_plot_date":view.date.iloc[-1].strftime("%Y-%m-%d"),
"files":["01_price_ma.png","02_volume_ma.png","03_macd.png","04_rsi.png","05_adx.png"],
"calculation_seconds":round(time.perf_counter()-start,3)}
(out/"report.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
print(json.dumps(report))
