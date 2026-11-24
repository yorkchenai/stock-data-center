"""Read at most three Eastmoney index histories for a local diagnostics report."""
from argparse import ArgumentParser
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import json
from math import isclose, isfinite
from pathlib import Path
from time import monotonic, sleep
from urllib.parse import urlencode

import pandas as pd

from scripts.audit_sector_volume import CORE, EASTMONEY
from stock_analysis import funds
from stock_analysis.sector_data import CSI_URL, error_status, session_index
from stock_analysis.sector_signals import finite_or_none, technical_series

UNIT_DOCUMENT = "https://github.com/akfamily/akshare/blob/main/docs/data/index/index.md#历史行情数据-通用"
EARLIER_SAMPLES = ("2021-01-04", "2022-12-06", "2024-06-28")
PRICE_COLUMNS = ("open", "close", "high", "low")


def number(raw):
    try:
        parsed = Decimal(raw)
    except InvalidOperation:
        return None
    return parsed if parsed.is_finite() and parsed >= 0 and isfinite(float(parsed)) else None


def observation(code, start, end, get=funds.download):
    market, name = CORE[code]
    dates = session_index(start, end)
    param = urlencode({"secid": f"{market}.{code}", "fields1": "f1,f2,f3,f4,f5,f6",
                       "fields2": "f51,f52,f53,f54,f55,f56,f57", "klt": 101, "fqt": 0,
                       "beg": start.replace("-", ""), "end": end.replace("-", "")})
    started = monotonic()
    data = json.loads(get(f"{EASTMONEY}?{param}")).get("data") or {}
    seconds = round(monotonic() - started, 3)
    if not data.get("klines"):
        return {"status": "no_data", "seconds": seconds}
    identity = {"code": data.get("code"), "name": data.get("name"), "market": data.get("market")}
    if type(identity["market"]) is not int or identity != {"code": code, "name": name, "market": int(market)}:
        return {"status": "identity_mismatch", "seconds": seconds, "identity": identity}

    allowed_dates = set(dates.strftime("%Y-%m-%d"))
    rows = {}
    for line in data["klines"]:
        day, *values = line.split(",")
        if day not in allowed_dates or day in rows or len(values) != 6:
            raise ValueError("invalid, duplicate or out-of-window kline date or fields")
        rows[day] = dict(zip((*PRICE_COLUMNS, "volume", "turnover"), map(number, values)))
    rows = dict(sorted(rows.items()))
    bad_prices = 0
    for item in rows.values():
        op, close, high, low = (item[key] for key in PRICE_COLUMNS)
        if not all((op, close, high, low)) or low > min(op, close) or high < max(op, close):
            bad_prices += 1
            item.update({key: None for key in PRICE_COLUMNS})
    frame = pd.DataFrame.from_dict(rows, orient="index").astype(float)
    frame.index = pd.to_datetime(frame.index)
    technical = technical_series(frame, dates, volume_unit="手")
    first, last = next(iter(rows)), next(reversed(rows))
    volume_rows = int(frame.volume.notna().sum())
    checks = {}
    for n in (5, 10):
        trailing = dates[dates <= pd.Timestamp(last)][-n:].strftime("%Y-%m-%d")
        exact = [rows.get(day) for day in trailing]
        if len(exact) < n or any(row is None or row["volume"] is None or row["close"] is None for row in exact):
            expected = None
        else:
            expected = float(sum(row["volume"] for row in exact) / n)
        actual = finite_or_none(technical.loc[last, f"VOL{n}"])
        if (expected is None) != (actual is None) or (
            expected is not None and not isclose(expected, actual, abs_tol=1e-8, rel_tol=1e-12)
        ):
            raise ValueError(f"independent last-observation VOL{n} mismatch")
        checks[f"VOL{n}"] = expected
    samples = {day: {key: float(val) if val is not None else None for key, val in rows[day].items()}
               for day in dict.fromkeys((*EARLIER_SAMPLES, last)) if day in rows}
    return {"status": "observed", "identity": identity, "seconds": seconds, "first": first, "last": last,
            "rows": len(rows), "expected_sessions": len(dates), "missing_sessions": len(dates) - len(rows),
            "volume_rows": volume_rows, "valid_ohlc_rows": len(rows) - bad_prices,
            "missing_or_invalid_volume": len(rows) - volume_rows, "volume_zero_rows": int(frame.volume.eq(0).sum()),
            "last_day_independent_check": checks, "samples": samples}


def audit(start, end, get=funds.download):
    if date.fromisoformat(start) > date.fromisoformat(end):
        raise ValueError("start must not follow end")
    results = {}
    restricted = False
    for code in CORE:
        if restricted:
            results[code] = {"status": "not_requested_after_restriction"}
            continue
        try:
            results[code] = observation(code, start, end, get=get)
        except (ValueError, KeyError, TypeError, OSError) as exc:
            results[code] = error_status(exc)
            restricted = results[code]["status"] == "access_restricted"
        sleep(.7)
    return {"purpose": "local_candidate_validation", "runtime_eligible": False, "queried_at": datetime.now(funds.SHANGHAI).isoformat(),
            "source": EASTMONEY, "source_field": "f56", "documented_unit": "手", "unit_document": UNIT_DOCUMENT,
            "start": start, "end": end, "indices": results}


def compare_cached_csi(indices, evidence):
    if evidence.get("source") != CSI_URL:
        raise ValueError("expected a previously validated CSI observations report")
    references = evidence["samples"]
    results = {}
    for code, index in indices.items():
        results[code] = {}
        for day, eastern in index.get("samples", {}).items():
            reference = references.get(code, {}).get(day, {}).get("csi")
            if not reference:
                results[code][day] = {"status": "no_same_day_reference"}
                continue
            volume = eastern.get("volume")
            turnover = eastern.get("turnover")
            metrics = (volume, turnover, reference.get("tradingVol"), reference.get("tradingValue"))
            if any(value is None for value in metrics) or any(
                source.get(key) is None for source in (eastern, reference) for key in PRICE_COLUMNS
            ):
                results[code][day] = {"status": "incomplete_comparison"}
                continue
            price_match = all(eastern[key] == reference[key] for key in PRICE_COLUMNS)
            volume_delta = Decimal(str(reference["tradingVol"])) - Decimal(str(volume)) * 100
            amount_delta = Decimal(str(reference["tradingValue"])) * 100_000_000 - Decimal(str(turnover))
            agrees = price_match and abs(volume_delta) <= 50 and abs(amount_delta) <= 500_000
            results[code][day] = {"status": "matches_rounding" if agrees else "source_conflict",
                                  "ohlc_matches": price_match, "volume_delta_shares": float(volume_delta),
                                  "amount_delta_yuan": float(amount_delta)}
    return results


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--start", default="2021-01-04")
    parser.add_argument("--end", required=True, help="last complete trading date to request")
    parser.add_argument("--output", type=Path, required=True, help="local file for aggregate results and scoped observations")
    parser.add_argument("--csi-evidence", type=Path, help="existing local CSI observations JSON; makes no new CSI requests")
    args = parser.parse_args()
    evidence = json.loads(args.csi_evidence.read_text(encoding="utf-8")) if args.csi_evidence else None
    result = audit(args.start, args.end)
    if evidence is not None:
        result["same_day_comparison"] = compare_cached_csi(result["indices"], evidence)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
                           encoding="utf-8")


if __name__ == "__main__":
    main()
