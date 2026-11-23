"""Read a few funds in memory and publish only availability/coverage metadata."""
from datetime import date, datetime, timezone
import json
import subprocess
from urllib.error import HTTPError, URLError

from stock_analysis.funds import (HISTORY_URL, assignment, current_catalog, download,
                                  growth_percent, nav_event, parse_history)


VERIFY_BROWSER_CONTRACT = """
import { readFileSync } from 'node:fs';
import { normalizeFund } from './web/funds/data.mjs';
import { analyzePerformance, PERIODS, periodReturn, periodStart, selectWindow } from './web/funds/performance.mjs';
const fund = normalizeFund(JSON.parse(readFileSync(0, 'utf8')));
const end = fund.rows.at(-1).date;
const checks = Object.fromEntries(PERIODS.map(([key]) => {
  const result = periodReturn(fund, key);
  return [key,{percent: result.value == null ? null : +(100 * result.value).toFixed(4), reason: result.reason}];
}));
const year = analyzePerformance(fund, selectWindow(fund, periodStart(end, '1y'), end)).metrics;
const referenceEnd = {'000001':'2026-11-20','000311':'2026-09-11','110017':'2024-12-31'}[fund.code];
const reference = referenceEnd ? Object.fromEntries(PERIODS.map(([key]) => {
  const range = selectWindow(fund, periodStart(referenceEnd, key), referenceEnd);
  const result = analyzePerformance(fund, range).metrics.return;
  return [key,{from:range.start, through:range.end,
    percent:result.value == null ? null : +(100 * result.value).toFixed(4), reason:result.reason}];
})) : null;
console.log(JSON.stringify({periods: checks, recent_year_risk: {
  drawdown: year.drawdown.value, volatility: year.volatility.value
}, reference_periods: reference}));
"""


def failure(error):
    if isinstance(error, HTTPError):
        return {"status": "upstream_http", "http_status": error.code}
    if isinstance(error, (URLError, TimeoutError)):
        return {"status": "network_unavailable", "detail": str(error)[:240]}
    return {"status": "invalid_response", "detail": str(error)[:240]}


def sample(code):
    try:
        text = download(HISTORY_URL.format(code=code))
        fund = parse_history(text, code, current_catalog().get(code))
    except (OSError, ValueError, OverflowError) as error:
        return {"code": code, **failure(error)}
    rows = fund["rows"]
    provider_rows = assignment(text, "Data_netWorthTrend")
    anomalies = []
    verified_events = []
    for i, row in enumerate(rows):
        if row["event_evidence"] is not None:
            verified_events.append({"date": row["date"], "source": row["event_evidence"],
                                    "cash_per_share": row["cash_distribution"], "shares_per_old_share": row["split_factor"],
                                    "status": row["return_issue"] or "validated"})
        if row["return_index"] is not None or not i:
            continue
        item, prev = provider_rows[i], rows[i - 1]
        value = item.get("unitMoney")
        event = nav_event(value)
        estimate_pp = None if event is None else round(100 * ((row["unit_nav"] * event[1] + event[0]) / prev["unit_nav"] - 1), 6)
        previous_total, current_total = prev["accumulated_nav"], row["accumulated_nav"]
        offset_change = None if previous_total is None or current_total is None else round(
            (current_total - row["unit_nav"]) - (previous_total - prev["unit_nav"]), 6)
        anomalies.append({"date": row["date"], "event": str(value)[:120], "unitMoney_present": "unitMoney" in item,
                          "source_daily_pct": growth_percent(item.get("equityReturn")), "calculated_daily_pct": estimate_pp,
                          "cumulative_offset_change": offset_change,
                          "reason": row["return_issue"]})
    start, end = (date.fromisoformat(rows[i]["date"]) for i in (0, -1))
    cutoff = end.replace(year=end.year - 5, day=28 if end.month == 2 and end.day == 29 else end.day)
    try:
        result = subprocess.run(["node", "--input-type=module", "-e", VERIFY_BROWSER_CONTRACT],
                                input=json.dumps(fund, ensure_ascii=False, allow_nan=False),
                                capture_output=True, text=True, check=True, timeout=10)
        return_checks = json.loads(result.stdout)
    except (subprocess.SubprocessError, OSError, ValueError):
        return_checks = None
    return {
        "code": code, "status": "ok", "category": fund["category"], "has_name": bool(fund["name"]),
        "first_nav": start.isoformat(), "last_nav": end.isoformat(), "observations": len(rows),
        "accumulated_observations": sum(row["accumulated_nav"] is not None for row in rows),
        "return_observations": sum(row["return_index"] is not None for row in rows),
        "return_basis": fund["return_basis"], "history_spans_five_years": start <= cutoff,
        "browser_contract_validated": return_checks is not None, "computable_return_periods": return_checks,
        "latest_unit_nav": rows[-1]["unit_nav"], "anomaly_report": anomalies,
        "reconciled_cash_count": sum(row["cash_distribution_source"] == "cumulative_nav_reconciled" for row in rows),
        "disclosure_events": verified_events,
    }


def main():
    try:
        catalog = {"status": "ok", "entries": len(current_catalog())}
    except (OSError, ValueError, OverflowError) as error:
        catalog = failure(error)
    result = {"checked_at": datetime.now(timezone.utc).isoformat(), "catalog": catalog,
              "funds": [sample(code) for code in ("000001", "000311", "110017", "161725")]}
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
