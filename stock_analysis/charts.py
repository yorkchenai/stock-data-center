"""Five PNG views consuming precomputed daily indicators."""
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

CHART_FILES = ["01_price_ma.png", "02_volume_ma.png", "03_macd.png", "04_rsi.png", "05_adx.png"]


def generate_charts(df, instrument, out, window=120):
    if window < 1:
        raise ValueError("Chart window must be positive")
    out.mkdir(parents=True, exist_ok=True)
    price_unit = "Index points" if instrument.kind == "index" else "CNY per share"
    view = df.tail(window).copy().reset_index(drop=True)
    x = np.arange(len(view))
    tick = np.arange(0, len(view), max(1, len(view) // 8))

    def setup(title, ylabel):
        fig, ax = plt.subplots(figsize=(14, 5.2), dpi=130)
        ax.set_title(instrument.symbol + " (" + instrument.kind + ") | " + title,fontsize=14)
        ax.set_ylabel(ylabel)
        ax.set_xticks(tick)
        ax.set_xticklabels(view.date.dt.strftime("%Y-%m-%d").iloc[tick],rotation=25,ha="right")
        ax.grid(alpha=.18)
        return fig, ax

    def save(fig, name):
        fig.tight_layout()
        try:
            fig.savefig(out / name, bbox_inches="tight")
        finally:
            plt.close(fig)

    fig, ax = setup("Price and moving averages",price_unit)
    for i,r in view.iterrows():
        col="#c0392b" if r.close>=r.open else "#198754"
        ax.vlines(i,r.low,r.high,color=col,lw=1)
        ax.vlines(i,min(r.open,r.close),max(r.open,r.close),color=col,lw=4)
    for n in [5,10,20,60]:
        ax.plot(x,view[f"MA{n}"],label=f"MA{n}",lw=1.3)
    ax.legend(ncol=4)
    save(fig,"01_price_ma.png")

    fig, ax = setup("Volume and moving averages","100-share lots")
    ax.bar(x,view.volume_lots,color=np.where(view.close>=view.open,"#c0392b","#198754"),alpha=.7)
    for n in [5, 10]:
        ax.plot(x, view[f"VOL{n}"], label=f"VOL{n}", lw=1.5)
    ax.legend()
    save(fig,"02_volume_ma.png")

    fig, ax = setup("MACD (12,26,9)",price_unit)
    ax.bar(x,view.MACD_hist,color=np.where(view.MACD_hist>=0,"#c0392b","#198754"),alpha=.6,label="2×(DIF−DEA)")
    ax.plot(x,view.DIF,label="DIF",lw=1.4)
    ax.plot(x,view.DEA,label="DEA",lw=1.4)
    ax.axhline(0, color="black", lw=.8)
    ax.legend()
    save(fig,"03_macd.png")

    fig, ax = setup("RSI (Wilder)","RSI")
    for n in [6,12,14,24]:
        ax.plot(x,view[f"RSI{n}"],label=f"RSI{n}",lw=1.5)
    for level in [30,50,70]:
        ax.axhline(level,color="gray",ls="--",lw=.8)
    ax.set_ylim(0, 100)
    ax.legend()
    save(fig,"04_rsi.png")

    fig, ax = setup("ADX (14) and directional indicators","ADX / DI")
    for name in ["ADX14","+DI","-DI"]:
        ax.plot(x,view[name],label=name,lw=1.5)
    for level in [25,40]:
        ax.axhline(level,color="gray",ls="--",lw=.8)
    ax.set_ylim(bottom=0)
    ax.legend()
    save(fig,"05_adx.png")

    return [out / name for name in CHART_FILES]
