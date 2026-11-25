"""Emit only aggregate comparison diagnostics. Histories stay in memory."""
from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
import json
from math import isclose, isfinite, prod, sqrt
import statistics
import subprocess
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import exchange_calendars as xcals

from stock_analysis.data import fetch_daily, request_json
from stock_analysis.funds import SHANGHAI, attach_benchmark_data, load_fund
from stock_analysis.fund_rates import fetch_rate_history, load_chinabond_rates
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
    benchmark_points:stats.points.benchmark.length,
    benchmark_reason:stats.comparison?.reason, sharpe:stats.metrics.sharpe.value,
    sharpe_reason:stats.metrics.sharpe.reason,
  });
}
for (const end of [asOf, fund.rows.at(-1).date]) {
  for (const period of ['1y','3y','5y']) summarize(period, periodStart(end,period), end);
}
if (fund.code === '000001') {
  for (const start of ['2026-07-24','2026-07-27']) summarize('benchmark change',start,asOf);
  summarize('post-change latest','2026-07-24',fund.rows.at(-1).date);
}
console.log(JSON.stringify(output));
"""


def independent_sharpe(rows, rates, start, end):
    if (not rates or not rates["effective_from"] <= start <= end <= rates["effective_to"]
            or any(start <= day <= end for day in rates["missing_dates"])):
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
    deviation = statistics.stdev(rows_excess) if len(rows_excess) >= 2 else 0
    return statistics.mean(rows_excess) / deviation * sqrt(252) if deviation else None


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


def official_equity_index(code, end):
    try:
        params = urlencode({"indexCode":code, "startDate":RATE_START.strftime("%Y%m%d"),
                            "endDate":end.strftime("%Y%m%d")})
        url = "https://www.csindex.com.cn/csindex-home/perf/index-perf"
        payload = request_json(f"{url}?{params}")
        rows = payload["data"]
        if not rows or any(str(row["indexCode"]) != code or not isfinite(float(row["close"]))
                           or float(row["close"]) <= 0 for row in rows):
            raise ValueError("empty or mismatched price series")
        levels = sorted((datetime.strptime(str(row["tradeDate"]), "%Y%m%d").date(), float(row["close"])) for row in rows)
        dates = [day.isoformat() for day, value in levels]
        if len(set(dates)) != len(dates):
            raise ValueError("duplicate CSI dates")
        calendar = xcals.get_calendar("XSHG", start="2021-09-01", end=end.isoformat())
        expected = set(calendar.sessions_in_range(RATE_START.isoformat(), end.isoformat()).strftime("%Y-%m-%d"))
        observed = set(dates)
        report = {"id":code, "basis":"price", "index_name":rows[0]["indexNameCnAll"], "source":"中证指数",
                  "first":dates[0], "last":dates[-1], "observations":len(dates),
                  "missing_sessions":len(expected-observed), "unexpected_dates":len(observed-expected)}
        if code == "000300" and not (expected-observed or observed-expected):
            report["fund_000311_method_check"] = []
            for anchor, disclosed in [("2025-09-30", -.0432), ("2023-09-28", .2275), ("2021-09-30", -.0265)]:
                selected = [(day, value) for day, value in levels if anchor <= day.isoformat() <= AS_OF]
                fraction = (selected[-1][0] - selected[0][0]).days / 365
                raw = selected[-1][1] / selected[0][1] - 1
                daily = prod(1 + .95 * (close / previous - 1) + .015 * (finish - start).days / 365
                             for (start, previous), (finish, close) in zip(selected, selected[1:])) - 1
                report["fund_000311_method_check"].append({"start":anchor, "end":AS_OF, "published":disclosed,
                    "price_only":raw, "period_weighted_simple_spread":.95 * raw + .015 * fraction,
                    "daily_weighted_simple_spread":daily})
        imported = {"id":code,"basis":"price","source":"中证指数",
                    "rows":[{"date":day.isoformat(),"value":value} for day, value in levels],
                    "calendar":{"from":RATE_START.isoformat(),"to":end.isoformat(),
                                "source":"XSHG","sessions":sorted(expected)}}
        return report, imported
    except (OSError, RuntimeError, ValueError, KeyError, TypeError) as error:
        return {"id":code, "error":str(error)}, None


def rate_history(end):
    try:
        return load_chinabond_rates(RATE_START, end, fetch_rate_history), None
    except (OSError, ValueError, TimeoutError) as error:
        return None, str(error)


def bond_composite_history(end):
    # Official catalog ID for the comprehensive index, with full price and all maturities.
    params = urlencode({"indexid":"2c90818811afed8d0111c0c672b31578","qxlxt":"00",
                        "zslxt":"QJZS","lx":"1","locale":"zh_CN"})
    errors = []
    for host in ("yield.chinabond.com.cn", "indices.chinabond.com.cn"):
        try:
            url = f"https://{host}/cbweb-mn/indices/singleIndexQuery?{params}"
            request = Request(url, method="POST", headers={"User-Agent":"Mozilla/5.0","Accept":"application/json"})
            with urlopen(request,timeout=15) as response:
                body = response.read(4_000_001)
            if len(body) > 4_000_000:
                raise ValueError("ChinaBond response exceeds the limit")
            data = json.loads(body)["QJZS_00"]
            if not isinstance(data, dict):
                raise ValueError("full-price levels not returned")
            source = "中债－综合指数（全价、总值）"
            selected = []
            hours = set()
            for timestamp, value in data.items():
                observed = datetime.fromtimestamp(int(timestamp)/1000, SHANGHAI)
                if RATE_START <= observed.date() <= end:
                    selected.append({"date":observed.date().isoformat(),"value":float(value)})
                    hours.add(observed.strftime("%H:%M"))
            selected.sort(key=lambda row: row["date"])
            if not selected or len({row["date"] for row in selected}) != len(selected) or any(
                not isfinite(row["value"]) or row["value"] <= 0 for row in selected
            ):
                raise ValueError("missing, duplicate or invalid comprehensive bond index levels")
            report = {"id":"CBA00203","basis":"full_price","source":source,
                      "first":selected[0]["date"],"last":selected[-1]["date"],
                      "observations":len(selected),"timestamp_local_times":sorted(hours)}
            return report, {"id":report["id"],"basis":report["basis"],"source":source,"rows":selected}
        except HTTPError as error:
            if error.code not in {502, 503, 504}:
                return {"id":"CBA00203","error":str(error)}, None
            errors.append(f"{host}: {error}")
        except (OSError, ValueError, KeyError, TypeError) as error:
            errors.append(f"{host}: {error}")
    return {"id":"CBA00203","error":" / ".join(errors)}, None


def main():
    with ThreadPoolExecutor(max_workers=4) as executor:
        funds_pending = executor.map(load_fund, CODES)
        index_pending = executor.submit(benchmark_component)
        funds = list(funds_pending)
        end = date.fromisoformat(max(fund["rows"][-1]["date"] for fund in funds))
        official_pending = [executor.submit(official_equity_index, code, end) for code in ("000300", "H30355")]
        bond_pending = executor.submit(bond_composite_history, end)
        rates, rate_error = executor.submit(rate_history, end).result()
        index = index_pending.result()
        broad_index, growth_index = (job.result() for job in official_pending)
        bond, bond_series = bond_pending.result()
    report = {"run_at":datetime.now(SHANGHAI).isoformat(),"price_index":index,
              "official_price_indices":[broad_index[0],growth_index[0]],
              "bond_index":bond,"rate_error":rate_error,"funds":{}}
    if rates:
        report["rate_history"] = {"name":rates["name"], "first":rates["rows"][0]["date"], "last":rates["effective_to"],
                                  "observations":len(rates["rows"]),"missing_sessions":rates["missing_dates"]}
    for fund in funds:
        if fund["code"] == "000001":
            components = [series for series in (growth_index[1], bond_series) if series]
            fund = attach_benchmark_data(fund, {"code":fund["code"],"series":components})
        result = subprocess.run(
            ["node","--input-type=module","-e",NODE], input=json.dumps({"payload":{**fund,"risk_free":rates},"asOf":AS_OF}),
            text=True, check=True, capture_output=True,
        )
        intervals = json.loads(result.stdout)
        for interval in intervals:
            independent = independent_sharpe(fund["rows"], rates, interval["start"], interval["end"])
            actual = interval["sharpe"]
            if (independent is None) != (actual is None):
                raise AssertionError("Python and JS Sharpe availability disagree")
            if independent is not None:
                if not isclose(independent, actual, rel_tol=1e-11, abs_tol=1e-11):
                    raise AssertionError("Python and JS Sharpe disagree")
                interval["sharpe_python_match"] = True
        report["funds"][fund["code"]] = intervals
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
