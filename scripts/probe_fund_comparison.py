"""Emit only aggregate comparison diagnostics. Histories stay in memory."""
from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
import json
from math import isclose, sqrt
import statistics
import subprocess

from stock_analysis.data import fetch_daily
from stock_analysis.funds import SHANGHAI, download, load_fund
from stock_analysis.fund_rates import load_chinabond_rates
from stock_analysis.symbols import resolve_symbol
from stock_analysis.validation import audit_calendar

CODES = ("000001", "000311", "110017")
AS_OF = "2026-09-30"
RATE_START = date(2021, 9, 28)
NODE = r"""
import { readFileSync } from 'node:fs';
import { normalizeFund } from './web/funds/data.mjs';
import { analyzePerformance, selectWindow, periodStart } from './web/funds/performance.mjs';
const {payload, asOf} = JSON.parse(readFileSync(0, 'utf8'));
const fund = normalizeFund(payload);
const output = [];
function summarize(label, date, end) {
  const window = selectWindow(fund, date, end);
  const stats = analyzePerformance(fund,window);
  output.push({
    label, start:window.start, end:window.end, observations:window.rows.length,
    fund_return:stats.metrics.return.value, excess:stats.metrics.excess.value,
    benchmark:stats.comparison?.value ?? null, benchmark_status:stats.comparison?.status,
    benchmark_reason:stats.comparison?.reason, sharpe:stats.metrics.sharpe.value,
    sharpe_reason:stats.metrics.sharpe.reason,
  });
}
for (const end of [asOf, fund.rows.at(-1).date]) {
  for (const period of ['1y','3y','5y']) summarize(period, periodStart(end,period), end);
}
if (fund.code === '000001') {
  for (const start of ['2026-07-24','2026-07-27']) summarize('benchmark change',start,asOf);
}
console.log(JSON.stringify(output));
"""


def independent_sharpe(rows, rates, start, end):
    if not rates or not rates["effective_from"] <= start <= end <= rates["effective_to"]:
        return None
    dates = [row["date"] for row in rates["rows"]]
    navs = [(date.fromisoformat(row["date"]), row["return_index"])
            for row in rows if start <= row["date"] <= end]
    rows_excess = []
    for (begin, base), (finish, last) in zip(navs, navs[1:]):
        i = bisect_right(dates, begin.isoformat()) - 1
        if i < 0 or (begin - date.fromisoformat(dates[i])).days > rates["max_age_days"] or not base or not last:
            return None
        accrued = rates["rows"][i]["annual_rate"] * (finish - begin).days / 365
        rows_excess.append(last / base - 1 - accrued)
    return statistics.mean(rows_excess) / statistics.stdev(rows_excess) * sqrt(252)


def benchmark_component():
    try:
        symbol = resolve_symbol("sh000300")
        start, end = "2021-09-28", "2026-11-20"
        validator = lambda frame: audit_calendar(frame, symbol, start, end)
        frame, source = fetch_daily(symbol, start, end, validator=validator)
        calendar = validator(frame)
        return {"id":"000300", "basis":"price", "source":source["source"], "observations":len(frame),
                "first":frame.date.iloc[0].date().isoformat(), "last":frame.date.iloc[-1].date().isoformat(),
                "expected_sessions":calendar["expected_sessions"], "missing_sessions":len(calendar["missing_sessions"])}
    except (OSError, RuntimeError, ValueError) as error:
        return {"id":"000300", "error":str(error)}


def rate_history(end):
    try:
        return load_chinabond_rates(RATE_START, end, download), None
    except (OSError, ValueError, TimeoutError) as error:
        return None, str(error)


def main():
    with ThreadPoolExecutor(max_workers=4) as executor:
        funds_pending = executor.map(load_fund, CODES)
        index_pending = executor.submit(benchmark_component)
        funds = list(funds_pending)
        end = date.fromisoformat(max(fund["rows"][-1]["date"] for fund in funds))
        rates, rate_error = executor.submit(rate_history, end).result()
        index = index_pending.result()
    report = {"run_at": datetime.now(SHANGHAI).isoformat(), "price_index":index,
              "rate_error":rate_error, "funds":{}}
    if rates:
        report["rate_history"] = {"name":rates["name"], "first":rates["rows"][0]["date"], "last":rates["effective_to"],
                                  "observations":len(rates["rows"])}
    for fund in funds:
        result = subprocess.run(
            ["node","--input-type=module","-e",NODE], input=json.dumps({"payload":{**fund,"risk_free":rates},"asOf":AS_OF}),
            text=True, check=True, capture_output=True,
        )
        intervals = json.loads(result.stdout)
        for interval in intervals:
            independent = independent_sharpe(fund["rows"], rates, interval["start"], interval["end"])
            if independent is not None and interval["sharpe"] is not None:
                if not isclose(independent, interval["sharpe"], rel_tol=1e-11, abs_tol=1e-11):
                    raise AssertionError("Python and JS Sharpe disagree")
                interval["sharpe_python_match"] = True
        report["funds"][fund["code"]] = intervals
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
