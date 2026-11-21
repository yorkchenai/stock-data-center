"""Compare saved daily dates against an independent Shanghai exchange calendar.

Requires: pip install exchange-calendars pandas
Run: python scripts/audit_exchange_calendar.py
"""
import csv
import json
from pathlib import Path
import pandas as pd
import exchange_calendars as xcals

source = Path("results/000688_daily.csv")
dates = [pd.Timestamp(r["date"]) for r in csv.DictReader(source.open(encoding="utf-8", newline=""))]
if not dates:
    raise SystemExit("No saved daily rows")
cal = xcals.get_calendar("XSHG")
start, end = min(dates), max(dates)
expected = {d.date().isoformat() for d in cal.sessions_in_range(start, end)}
actual = {d.date().isoformat() for d in dates}
missing = sorted(expected - actual)
unexpected = sorted(actual - expected)
report = {
    "calendar": "exchange_calendars:XSHG",
    "calendar_is_independent": True,
    "start": start.date().isoformat(),
    "end": end.date().isoformat(),
    "expected_sessions": len(expected),
    "observed_unique_dates": len(actual),
    "missing_sessions": missing,
    "unexpected_dates": unexpected,
    "calendar_match": not missing and not unexpected,
    "caveat": "Calendar comparison does not independently verify price, volume, or index-specific suspension rules."
}
out = Path("results/000688_calendar_audit.json")
out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
if not report["calendar_match"]:
    raise SystemExit(1)
