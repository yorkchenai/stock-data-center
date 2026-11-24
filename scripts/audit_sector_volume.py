"""Sample index volume sources without retaining complete histories."""
from argparse import ArgumentParser
from datetime import datetime
import json
from pathlib import Path
from time import sleep
from urllib.parse import urlencode

import numpy as np

from stock_analysis import funds
from stock_analysis.sector_data import CSI_URL, collect_indices, error_status

CORE = {"399997": ("0", "中证白酒"), "000994": ("1", "全指通信"), "000991": ("1", "全指医药")}
EASTMONEY = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
DATE_SAMPLES = ("2022-12-06", "2024-06-28", "2026-11-23")


def value(row, name):
    result = row[name]
    return float(result) if np.isfinite(result) else None


def eastmoney_day(code, day):
    market, name = CORE[code]
    date = day.replace("-", "")
    params = urlencode({"secid": f"{market}.{code}", "fields1": "f57,f58", "fields2": "f51,f52,f53,f54,f55,f56,f57",
                       "klt": 101, "fqt": 0, "beg": date, "end": date})
    data = json.loads(funds.download(f"{EASTMONEY}?{params}")).get("data")
    if not data or not data.get("klines"):
        return {"status": "no_data"}
    if data.get("code") != code or data.get("name") != name:
        return {"status": "identity_mismatch", "code": data.get("code"), "name": data.get("name")}
    rows = data["klines"]
    if len(rows) != 1:
        return {"status": "date_mismatch"}
    observed, opened, closed, high, low, volume, amount = rows[0].split(",")
    if observed != day:
        return {"status": "date_mismatch"}
    fields = [float(x) for x in (opened, closed, high, low, volume, amount)]
    if not all(np.isfinite(fields)) or min(fields) < 0:
        return {"status": "invalid_numeric_fields"}
    return dict(zip(("open", "close", "high", "low", "f56", "f57"), fields), status="ok")


def audit(start, end):
    histories, coverage = collect_indices(start, end)
    samples = {}
    constrained = False
    for code in CORE:
        frame = histories.get(code)
        dates = sorted(set(day for day in (*DATE_SAMPLES, coverage[code].get("last")) if day and start <= day <= end))
        samples[code] = {}
        for day in dates:
            item = {}
            if frame is not None and day in frame.index:
                row = frame.loc[day]
                item["csi"] = {**{key: value(row, key) for key in ("open", "high", "low", "close")},
                               "tradingVol": value(row, "volume"), "tradingValue": value(row, "turnover")}
            if constrained:
                item["eastmoney"] = {"status": "not_requested_after_restriction"}
            else:
                try:
                    item["eastmoney"] = eastmoney_day(code, day)
                except (ValueError, KeyError, TypeError, OSError) as exc:
                    item["eastmoney"] = error_status(exc)
                    constrained = item["eastmoney"]["status"] == "access_restricted"
                sleep(.7)
            samples[code][day] = item
    return {"schema_version": 1, "as_of": datetime.now(funds.SHANGHAI).isoformat(), "start": start, "end": end,
            "source": CSI_URL, "comparison_source": EASTMONEY, "indices": coverage, "samples": samples}


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--start", default="2021-01-04")
    parser.add_argument("--end", default=datetime.now(funds.SHANGHAI).date().isoformat())
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(audit(args.start, args.end), ensure_ascii=False, indent=2, allow_nan=False)+"\n",
                           encoding="utf-8")


if __name__ == "__main__":
    main()
