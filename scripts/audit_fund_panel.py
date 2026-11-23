"""Run a reproducible real-data fund audit. The output contains summaries only."""
from argparse import ArgumentParser
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from io import BytesIO
import importlib.util
import json
from math import isclose, sqrt
from pathlib import Path
import re
import statistics
import subprocess
import tarfile
from tempfile import TemporaryDirectory
from threading import Lock
from time import monotonic, sleep
from urllib.error import HTTPError, URLError

from bs4 import BeautifulSoup

from stock_analysis import funds
from stock_analysis.fund_rates import fetch_rate_history, load_chinabond_rates

ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "tests/fixtures/fund_generalization_panel.json"
BRIDGE = ROOT / "scripts/audit_fund_window.mjs"
PROFILE_URL = "https://fundf10.eastmoney.com/jbgk_{}.html"
RISK = {"sharpe", "volatility", "sortino"}
PERIODS = ("1m", "3m", "6m", "1y", "3y", "5y", "all")


class RequestPacer:
    def __init__(self):
        self.lock = Lock()
        self.next_start = 0.0

    def __call__(self, url):
        with self.lock:
            sleep(max(0, self.next_start - monotonic()))
            self.next_start = monotonic() + .35
        return funds.download(url)


def failure(error):
    if isinstance(error, HTTPError):
        return {"kind":"source_unavailable","http_status":error.code}
    if isinstance(error, (TimeoutError, URLError, OSError)):
        return {"kind":"source_unavailable","error":type(error).__name__}
    message = str(error)
    kind = "identity" if "不同的基金代码" in message or "场外基金名称" in message else "source_data"
    return {"kind":kind,"reason":message[:180]}


def catalog_profile(html, code):
    soup = BeautifulSoup(html, "html.parser")
    fields = {}
    for row in soup.select("tr"):
        cells = row.find_all(["td","th"], recursive=False)
        for label, value in zip(cells, cells[1:]):
            if label.name == "th" and value.name == "td":
                fields[label.get_text(strip=True)] = value.get_text(" ", strip=True)
    identities = re.findall(r"(?<!\d)\d{6}(?!\d)", fields.get("基金代码", ""))
    if code not in identities:
        return {"status":"unverified_identity"}
    inception = next((re.search(r"\d{4}-\d{2}-\d{2}", v) for k, v in fields.items() if k.startswith("成立日期")), None)
    return {"status":"matched","inception":inception[0] if inception else None,
            "manager":fields.get("基金管理人"),"type":fields.get("基金类型"),
            "candidate_benchmark":fields.get("业绩比较基准"),"tracking":fields.get("跟踪标的"),
            "source":PROFILE_URL.format(code)}


def run_engine(root, data, as_of=None):
    call = subprocess.run(["node",str(BRIDGE),str(root)], cwd=root, check=False,
                          input=json.dumps({"data":data,"asOf":as_of},allow_nan=False),
                          capture_output=True, text=True, timeout=25)
    if call.returncode:
        match = re.search(r"^Error: (.+)$",call.stderr,re.M)
        raise ValueError(match[1] if match else "Node audit calculation failed")
    return json.loads(call.stdout)


def independent(rows, rates, start, end, daily):
    observations = [row for row in rows if start <= row["date"] <= end]
    if len(observations)<2 or any(row["return_index"] is None for row in observations):
        return {}
    # Recompute the adjusted path from cash and share factors. The feed's
    # event interpretation is checked separately against published disclosures.
    levels = [1.0]
    daily_returns = []
    for previous, row in zip(observations,observations[1:]):
        if row["split_factor"] is None or row["cash_distribution"] is None:
            return {}
        change = (row["unit_nav"] * row["split_factor"] + row["cash_distribution"]) / previous["unit_nav"]
        levels.append(levels[-1] * change)
        daily_returns.append(change - 1)
    peak = levels[0]
    drawdown = 0
    for level in levels:
        peak = max(peak,level)
        drawdown = min(drawdown,level/peak-1)
    output = {"return":levels[-1]-1,"drawdown":drawdown}
    dates = list(map(lambda row: date.fromisoformat(row["date"]), observations))
    if not daily or len(daily_returns)<2 or any((right-left).days > 14 for left,right in zip(dates,dates[1:])):
        return output
    output["volatility"] = statistics.stdev(daily_returns)*sqrt(252)
    downside = sqrt(statistics.fmean(min(0, x)**2 for x in daily_returns))
    if downside:
        output["sortino"] = statistics.fmean(daily_returns)/downside*sqrt(252)
    if (rates and rates["effective_from"] <= start <= end <= rates["effective_to"]
            and not any(start <= missing <= end for missing in rates["missing_dates"])):
        from bisect import bisect_right
        quote_days = [date.fromisoformat(row["date"]) for row in rates["rows"]]
        excess = []
        for left, right, daily_return in zip(dates,dates[1:],daily_returns):
            index = bisect_right(quote_days,left)-1
            if index < 0 or (left-quote_days[index]).days > rates["max_age_days"]:
                break
            interest = rates["rows"][index]["annual_rate"]*(right-left).days/365
            excess.append(daily_return-interest)
        if len(excess)==len(daily_returns) and statistics.stdev(excess):
            output["sharpe"] = statistics.fmean(excess)/statistics.stdev(excess)*sqrt(252)
    return output


def classify_window(result, data, rates, inception):
    for key, window in result["windows"].items():
        window["sources"] = {"nav":data["source"]["name"],"risk":rates and rates["name"],
                             "benchmark":data.get("benchmark") and data["benchmark"]["source"]}
        start,end = window.get("start"),window.get("end")
        target = window["requested_start"]
        short = bool(target and inception and inception > target and (date.fromisoformat(inception)-date.fromisoformat(target)).days > 7)
        if key != "all" and target and not start and not inception:
            window["history_applicability"] = "unknown"
        verification = independent(data["rows"],rates,start,end,result["normal_frequency"]) if start and end else {}
        for metric, item in window["metrics"].items():
            value, reason = item["value"], item.get("reason") or ""
            if short:
                status = "insufficient_fund_age"
            elif metric in RISK and data["category"] in {"qdii","fof","money"}:
                status = "unsupported_type"
            elif value is not None:
                status = "calculated"
            elif window["error"] or "不足两条" in reason or "相隔超过" in reason or "起点附近" in reason:
                status = "source_data"
            elif metric == "excess" and window["metrics"]["return"]["value"] is not None:
                status = "benchmark_missing_history" if data.get("benchmark") else "benchmark_not_configured"
            elif metric == "sharpe" and "利率" in reason:
                status = "risk_free_missing"
            elif "为零" in reason:
                status = "undefined_metric"
            elif "分红" in reason or "折算" in reason or "总回报" in reason or "净值增长率" in reason or "相邻净值" in reason:
                status = "event_unverified"
            else:
                status = "source_data"
            expected = verification.get(metric)
            item["status"] = status
            item["verification"] = "not_checked"
            if status == "calculated" and expected is not None:
                item["verification"] = "pass" if isclose(value,expected,abs_tol=1e-10,rel_tol=1e-10) else "mismatch"
                if item["verification"] == "mismatch":
                    item["difference"] = value-expected
            elif status == "calculated" and metric == "excess":
                entry = next((r for r in data["benchmark"].get("disclosed_periods",[]) if r["start"]==start and r["end"]==end), None)
                if entry and "return" in verification:
                    item["verification"] = ("pass" if isclose(value,verification["return"]-entry["return"],abs_tol=1e-10)
                                            else "mismatch")
        list_result = result["list"].get(key)
        detail_return = window["metrics"]["return"]
        if list_result and list_result["value"] is None and detail_return["value"] is not None:
            window["list_detail_inconsistency"] = list_result["reason"]
    return result


def describe_history(raw, data):
    events = [row for row in raw if row.get("unitMoney") and str(row.get("unitMoney")).strip()]
    rows = data["rows"]
    delays = [(date.fromisoformat(b["date"])-date.fromisoformat(a["date"])).days for a,b in zip(rows,rows[1:])]
    return {"count":len(rows),"first":rows[0]["date"],"last":rows[-1]["date"],
            "cash_events":sum(bool(row["cash_distribution"]) for row in rows),
            "split_events":sum(row["split_factor"] not in (None,1) for row in rows),
            "issues":dict(Counter(row["return_issue"] for row in rows if row["return_issue"])),
            "issue_examples":[{"date":row["date"],"issue":row["return_issue"],
                              "event":str(original.get("unitMoney",""))[:120]}
                              for row,original in zip(rows,raw) if row["return_issue"]][:10],
            "event_labels":len(events),"max_calendar_gap":max(delays,default=0)}


def benchmark_state(data, windows):
    if not data.get("benchmark"):
        return "A_missing_audited_configuration"
    if any(w["benchmark_status"]=="complete" and w["metrics"]["excess"]["verification"]=="pass" for w in windows.values()):
        return "D_complete_and_verified"
    return "B_missing_history_or_verified_method"


def run(main_args):
    selection = json.loads(PANEL.read_text())
    fixture = [(group,*sample) for group, samples in selection["cohorts"].items() for sample in samples]
    assert len(fixture)==30 and len({item[1] for item in fixture})==30 and all(len(v)==5 for v in selection["cohorts"].values())
    fixture += [("regression",code,None,"既有三阶段回归") for code in selection["regressions"]]
    clock = datetime.now(funds.SHANGHAI)
    request = RequestPacer()
    try:
        catalog = funds.parse_catalog(request(funds.CATALOG_URL))
        catalog_error = None
    except (ValueError,OSError) as error:
        catalog, catalog_error = {}, failure(error)
    begin = monotonic()

    def capture(sample):
        _,code,_,_ = sample
        info = {}
        t0 = monotonic()
        try:
            info["history"] = request(funds.HISTORY_URL.format(code=code))
            info["retrieved_at"] = datetime.now(funds.SHANGHAI)
        except (ValueError,OSError) as error:
            info["history_error"] = failure(error)
        info["history_ms"] = round((monotonic()-t0)*1000,2)
        try:
            info["profile"] = catalog_profile(request(PROFILE_URL.format(code)),code)
        except (ValueError,OSError) as error:
            info["profile"] = failure(error)
        return info

    with ThreadPoolExecutor(max_workers=2) as executor:
        captured = list(executor.map(capture,fixture))
    batch_seconds = round(monotonic()-begin,2)
    as_of = clock.date()-timedelta(days=0)
    valuation_dates = []
    for incoming in captured:
        if "history" in incoming:
            try:
                raw = funds.assignment(incoming["history"],"Data_netWorthTrend")
                if raw:
                    valuation_dates.append(date.fromisoformat(funds.timestamp_day(raw[-1]["x"])))
            except (ValueError,TypeError,KeyError):
                pass
    try:
        rates = load_chinabond_rates(date(2021,9,1),max(valuation_dates,default=as_of),fetch_rate_history)
        rate_summary = {"source":rates["source"], "start":rates["rows"][0]["date"],"end":rates["effective_to"],
                        "observations":len(rates["rows"]), "missing_count":len(rates["missing_dates"])}
    except (OSError,ValueError) as error:
        rates, rate_summary = None, failure(error)
    report = {"baseline":selection["baseline"],"at":clock.isoformat(),"catalog_count":len(catalog),
              "catalog_error":catalog_error,"rate":rate_summary,"batch_seconds":batch_seconds,"funds":[]}

    with TemporaryDirectory() as temp:
        baseline = Path(temp)
        archive = subprocess.check_output(["git","archive",selection["baseline"],"stock_analysis","web"],cwd=ROOT)
        with tarfile.open(fileobj=BytesIO(archive)) as snapshot:
            snapshot.extractall(baseline,filter="data")
        spec = importlib.util.spec_from_file_location("stock_analysis.pinned_funds",baseline/"stock_analysis/funds.py")
        pinned = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pinned)

        for (group,code,label,reason), incoming in zip(fixture,captured):
            profile = incoming["profile"]
            metadata = catalog.get(code,{})
            obj = {"code":code,"group":group,"selection_name":label,"selection_reason":reason,
                   "catalog":metadata or None,"profile":profile,"history_request_ms":incoming["history_ms"]}
            report["funds"].append(obj)
            if "history_error" in incoming:
                obj["history_error"] = incoming["history_error"]
                continue
            for name, path, adapter in (("baseline",baseline,pinned),("current",ROOT,funds)):
                try:
                    payload = adapter.parse_history(incoming["history"],code,metadata,incoming["retrieved_at"])
                    obj[name] = {"history":describe_history(adapter.assignment(incoming["history"],"Data_netWorthTrend"),payload),
                                 "name":payload["name"],"category":payload["category"]}
                    current = {**payload,"risk_free":rates}
                    result = run_engine(path,current)
                    obj[name].update(classify_window(result,payload,rates,profile.get("inception")))
                    obj[name]["benchmark_state"] = benchmark_state(payload,obj[name]["windows"])
                    obj[name]["as_received_sharpe_possible"] = bool(payload.get("risk_free"))
                except (ValueError,TypeError,OSError,subprocess.SubprocessError) as error:
                    obj[name] = {"error":failure(error)}
    return report


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,required=True)
    args = parser.parse_args()
    report = run(args)
    args.output.write_text(json.dumps(report,ensure_ascii=False,allow_nan=False,indent=2)+"\n",encoding="utf8")
    parsed = sum("history" in row.get("current",{}) for row in report["funds"] if row["group"]!="regression")
    print(f"Fund histories validated: {parsed}/30. Aggregate audit: {args.output}")


if __name__ == "__main__":
    main()
