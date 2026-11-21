"""Isolated BaoStock candidate test; never overwrites production market data."""
import json
from datetime import datetime, timezone
from pathlib import Path
import baostock as bs

report = {"source": "BaoStock", "symbol": "sh.000688", "tested_at_utc": datetime.now(timezone.utc).isoformat(), "status": "failed"}
fields = "date,code,open,high,low,close,volume,amount"
rows = []
logged_in = False
try:
    login = bs.login()
    if login.error_code != "0":
        raise RuntimeError("BaoStock login: " + login.error_msg)
    logged_in = True
    result = bs.query_history_k_data_plus("sh.000688", fields, start_date="2020-07-01", end_date="2026-11-20", frequency="d")
    if result.error_code != "0":
        raise RuntimeError("BaoStock query: " + result.error_msg)
    while result.next():
        rows.append(dict(zip(result.fields, result.get_row_data())))
    if not rows:
        raise ValueError("No index history returned")
    dates = [r["date"] for r in rows]
    if dates != sorted(set(dates)):
        raise ValueError("Duplicate or unordered dates")
    missing = {field: sum(not row.get(field) for row in rows) for field in ("open", "high", "low", "close", "volume", "amount")}
    report.update(rows=len(rows), first_date=dates[0], last_date=dates[-1], missing_fields=missing)
    if dates[0] > "2020-07-01" or dates[-1] < "2026-11-20" or any(missing.values()):
        raise ValueError("Incomplete history or missing required values")
    report["status"] = "success"
except Exception as exc:
    report["error"] = str(exc)
finally:
    if logged_in:
        bs.logout()
    Path("results").mkdir(exist_ok=True)
    Path("results/baostock_candidate_test.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
if report["status"] != "success":
    raise SystemExit(1)
