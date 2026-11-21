"""Eastmoney primary and Tencent fallback, normalized to unadjusted prices."""
import json
import urllib.parse
import urllib.request

import pandas as pd

from .validation import COLUMNS, normalize_daily

HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json,text/plain,*/*"}


def request_json(url):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=25) as response:
        return json.load(response)


def eastmoney(instrument, start, end):
    url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?" + urllib.parse.urlencode({
        "secid": instrument.secid, "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "klt": "101", "fqt": "0", "beg": start.replace("-", ""), "end": end.replace("-", ""),
    })
    payload = request_json(url)
    data = payload.get("data") or {}
    if data.get("code", instrument.code) != instrument.code:
        raise ValueError("Eastmoney returned a different instrument")
    rows = []
    for item in data.get("klines") or []:
        fields = item.split(",")
        if len(fields) < 7:
            raise ValueError("Incomplete Eastmoney daily row")
        rows.append(fields[:7])
    return pd.DataFrame(rows, columns=COLUMNS)


def tencent(instrument, start, end):
    import akshare as ak

    # The stock adapter also supports indices and explicitly requests unadjusted
    # prices. index_zh_daily_tx always requests qfq, unsuitable for stock fallback.
    frame = ak.stock_zh_a_hist_tx(
        symbol=instrument.symbol, start_date=start.replace("-", ""),
        end_date=end.replace("-", ""), adjust="",
    )
    required = ["date", "open", "close", "high", "low", "volume", "amount"]
    if not set(required).issubset(frame.columns):
        raise ValueError("Tencent must supply OHLC, volume in shares and amount in CNY")
    frame = frame[required].rename(columns={"volume": "volume_lots", "amount": "turnover_cny"}).copy()
    frame["volume_lots"] = pd.to_numeric(frame.volume_lots, errors="raise") / 100
    return frame


class FetchError(RuntimeError):
    def __init__(self, attempts):
        self.attempts = attempts
        super().__init__("All data sources failed: " + json.dumps(attempts, ensure_ascii=False))


def fetch_daily(instrument, start, end, source="auto", validator=None):
    providers = {"eastmoney": eastmoney, "tencent": tencent}
    names = list(providers) if source == "auto" else [source]
    if any(name not in providers for name in names):
        raise ValueError("source must be auto, eastmoney or tencent")
    attempts = []
    for name in names:
        try:
            frame = normalize_daily(providers[name](instrument, start, end))
            frame = frame[frame.date.between(start, end)].reset_index(drop=True)
            if frame.empty:
                raise ValueError("No rows in requested period")
            if validator:
                validator(frame)
            attempts.append({"source": name, "status": "success", "rows": len(frame)})
            return frame, {"source": name, "adjustment": "none", "attempts": attempts,
                           "volume_unit": "100-share lots", "turnover_unit": "CNY"}
        except Exception as exc:
            attempts.append({"source": name, "status": "failed", "error": f"{type(exc).__name__}: {exc}"})
    raise FetchError(attempts)
