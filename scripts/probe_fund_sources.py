"""Read a few funds in memory and publish only availability/coverage metadata."""
from datetime import date, datetime, timezone
import json
import subprocess
from urllib.error import HTTPError, URLError

from stock_analysis.funds import current_catalog, load_fund


VERIFY_BROWSER_CONTRACT = """
import { readFileSync } from 'node:fs';
import { normalizeFund } from './web/funds/data.mjs';
import { PERIODS, periodReturn } from './web/funds/performance.mjs';
const fund = normalizeFund(JSON.parse(readFileSync(0, 'utf8')));
const checks = PERIODS.map(([key]) => [key, periodReturn(fund, key).value !== null]);
console.log(JSON.stringify(Object.fromEntries(checks)));
"""


def failure(error):
    if isinstance(error, HTTPError):
        return {"status": "upstream_http", "http_status": error.code}
    if isinstance(error, (URLError, TimeoutError)):
        return {"status": "network_unavailable", "detail": str(error)[:240]}
    return {"status": "invalid_response", "detail": str(error)[:240]}


def sample(code):
    try:
        fund = load_fund(code)
    except (OSError, ValueError, OverflowError) as error:
        return {"code": code, **failure(error)}
    rows = fund["rows"]
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
    }


def main():
    try:
        catalog = {"status": "ok", "entries": len(current_catalog())}
    except (OSError, ValueError, OverflowError) as error:
        catalog = failure(error)
    result = {"checked_at": datetime.now(timezone.utc).isoformat(), "catalog": catalog,
              "funds": [sample(code) for code in ("000001", "000311", "110017")]}
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
