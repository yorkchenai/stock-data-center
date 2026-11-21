"""Offline integrity audit for saved daily OHLCV data (no exchange-calendar claim)."""
import csv
import json
from datetime import date
from pathlib import Path

path = Path("results/000688_daily.csv")
rows = list(csv.DictReader(path.open(encoding="utf-8", newline="")))
issues = []
dates = []
for i, row in enumerate(rows, start=2):
    try:
        d = date.fromisoformat(row["date"])
        dates.append(d)
        op, cl, hi, lo = (float(row[k]) for k in ("open", "close", "high", "low"))
        volume = float(row["volume_lots"])
        turnover = float(row["turnover_cny"])
        if min(op, cl, hi, lo) <= 0 or lo > min(op, cl) or hi < max(op, cl):
            issues.append(f"line {i}: inconsistent OHLC")
        if volume < 0 or turnover < 0:
            issues.append(f"line {i}: negative volume or turnover")
        if d.weekday() >= 5:
            issues.append(f"line {i}: weekend date")
    except (KeyError, ValueError, TypeError) as exc:
        issues.append(f"line {i}: {exc}")
if dates != sorted(set(dates)):
    issues.append("dates not strictly increasing or duplicated")
result = {
    "rows": len(rows), "first_date": str(dates[0]) if dates else None,
    "last_date": str(dates[-1]) if dates else None,
    "basic_integrity_pass": not issues, "issues": issues[:100],
    "exchange_calendar_verified": False,
    "volume_unit_verified": False,
    "note": "Trading-day completeness requires an independent SSE trading calendar; source unit conventions require independent confirmation."
}
print(json.dumps(result, ensure_ascii=False, indent=2))
Path("results/000688_validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
if issues:
    raise SystemExit(1)
