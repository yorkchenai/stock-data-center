"""Run a reproducible real-data fund audit. The output contains summaries only."""
from argparse import ArgumentParser
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
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
from scripts.audit_fund_interactions import measure_interactions

ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "tests/fixtures/fund_generalization_panel.json"
BRIDGE = ROOT / "scripts/audit_fund_window.mjs"
DISCLOSURES = ROOT / "tests/fixtures/fund_generalization_disclosures.json"
PROFILE_URLS = ("https://fundf10.eastmoney.com/jbgk_{}.html",
                "https://fund.eastmoney.com/data/xininfo_{}.html")
RISK = {"sharpe", "volatility", "sortino"}
PERIODS = ("1m", "3m", "6m", "1y", "3y", "5y", "all")
METRICS = ("return", "drawdown", "sharpe", "volatility", "sortino")
NOT_APPLICABLE = {"insufficient_fund_age","unsupported_type"}


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


def catalog_profile(html, code, source):
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
    inception = next((re.search(r"(\d{4})[年-](\d{2})[月-](\d{2})", v) for k, v in fields.items()
                      if k.startswith("成立日期")), None)
    return {"status":"matched","inception":"-".join(inception.groups()) if inception else None,
            "manager":fields.get("基金管理人"),"type":fields.get("基金类型"),
            "candidate_benchmark":fields.get("业绩比较基准"),"tracking":fields.get("跟踪标的"),
            "source":source}


def run_engine(root, data, as_of=None):
    call = subprocess.run(["node",str(BRIDGE),str(root)], cwd=root, check=False,
                          input=json.dumps({"data":data,"asOf":as_of},allow_nan=False),
                          capture_output=True, text=True, timeout=25)
    if call.returncode:
        match = re.search(r"^Error: (.+)$",call.stderr,re.M)
        raise ValueError(match[1] if match else "Node audit calculation failed")
    return json.loads(call.stdout)


def independent(rows, rates, start, end, daily, reference=None):
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
    if reference:
        sessions = reference["observations_per_year"]
        daily_reference = (1 + reference["annual_rate"]) ** (1 / sessions) - 1
        if not isclose(daily_reference, reference["daily_rate"], abs_tol=1e-15):
            raise ValueError("快照日参考收益率与年化参数不一致")
        excess = [value - daily_reference for value in daily_returns]
        volatility = statistics.stdev(daily_returns)
        downside = sqrt(statistics.fmean(min(0, value) ** 2 for value in excess))
        output["volatility"] = volatility * sqrt(sessions)
        if volatility:
            output["sharpe"] = statistics.fmean(excess) / volatility * sqrt(sessions)
        if downside:
            output["sortino"] = statistics.fmean(excess) / downside * sqrt(sessions)
        return output
    # Retain independent reading of archives created under the historical rate convention.
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


def classify_window(result, data, inception, group):
    for key, window in result["windows"].items():
        window["sources"] = {"nav":data["source"]["name"],"risk":result["reference"],
                             "benchmark":data.get("benchmark") and data["benchmark"]["source"]}
        start,end = window.get("start"),window.get("end")
        target = window["requested_start"]
        short = bool(target and inception and inception > target)
        event = next((row["return_issue"] for row in data["rows"] if start and start <= row["date"] <= end
                      and row["return_issue"]), None)
        if key != "all" and target and not start and not inception:
            window["history_applicability"] = "unknown"
        verification = independent(data["rows"],None,start,end,result["normal_frequency"],result["reference"]) if start and end else {}
        for metric, item in window["metrics"].items():
            value, reason = item["value"], item.get("reason") or ""
            if short:
                status = "insufficient_fund_age"
            elif metric in RISK and (group == "special" or data["category"] in {"qdii","fof","money"}):
                status = "unsupported_type"
                if value is not None:
                    item["unexpected_numeric_output"] = True
            elif value is not None:
                status = "calculated"
            elif window["error"] or "不足两条" in reason or "相隔超过" in reason or "起点附近" in reason:
                status = "source_data"
            elif metric == "sharpe" and "利率" in reason:
                status = "risk_free_missing"
            elif "为零" in reason:
                status = "undefined_metric"
            elif event or "总回报" in reason:
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


def disclosure_check(root, payload, definition):
    """Public report aggregates are evidence, never fed into the engine."""
    cases = {}
    official_periods = definition.get("periods")
    if official_periods:
        output = run_engine(root,payload,as_of=definition["end"])
    for key, official in (official_periods or {}).items():
        window = output["windows"][key]
        actual = window["metrics"]["return"]["value"]
        difference = None if actual is None else actual-official["return"]
        confirmed = (window.get("end")==definition["end"] and window.get("start")==official["start"]
                     and difference is not None and abs(difference)<=.0002)
        cases[key] = {"start":window.get("start"),"end":window.get("end"),
                      "official":official,"system_return":actual,"difference":difference,
                      "matches":confirmed,"reason":window["metrics"]["return"]["reason"],
                      "official_net_value_std":official.get("daily_std"),
                      "system_volatility":window["metrics"]["volatility"]["value"],
                      "system_sharpe":window["metrics"]["sharpe"]["value"],
                      "system_drawdown":window["metrics"]["drawdown"]["value"]}
    check = {"source":definition["source"],"formula":definition.get("formula"),"windows":cases}
    if "benchmark_change" in definition:
        check["benchmark_change"] = definition["benchmark_change"]
    event = definition.get("event")
    if event:
        index = next((i for i, row in enumerate(payload["rows"]) if row["date"]==event["date"]),None)
        if index is not None and index > 0:
            previous,current = payload["rows"][index-1:index+1]
            actual = current[event["field"]]
            check["event"] = {**event,"actual":actual,"matches":actual is not None and isclose(actual,event["expected"],abs_tol=1e-6),
                              "nav_only_return":current["unit_nav"]/previous["unit_nav"]-1,
                              "adjusted_return":(current["return_index"]/previous["return_index"]-1
                                                 if current["return_index"] and previous["return_index"] else None)}
    return check


def coverage(records, version):
    cohort = [row for row in records if row["group"]!="regression"]
    summary = {}
    for horizon in PERIODS:
        summary[horizon] = {}
        for metric in METRICS:
            items = []
            for row in cohort:
                version_result = row.get(version,{})
                item = version_result.get("windows",{}).get(horizon,{}).get("metrics",{}).get(metric)
                items.append(item or {"status": (row.get("history_error") or version_result.get("error")
                                                or {"kind":"source_data"})["kind"]})
            statuses = Counter(item["status"] for item in items)
            passed = sum(item.get("verification")=="pass" for item in items)
            checked = passed + sum(item.get("verification")=="mismatch" for item in items)
            summary[horizon][metric] = {"total":len(items),
                "applicable":len(items)-sum(statuses[status] for status in NOT_APPLICABLE),
                "calculated":statuses["calculated"],"independent_pass":passed,
                "independent_checked":checked,"status_counts":dict(statuses),
                "unexpected_numeric":sum(item.get("unexpected_numeric_output",False) for item in items)}
    return summary


def run():
    selection = json.loads(PANEL.read_text())
    fixture = [(group,*sample) for group, samples in selection["cohorts"].items() for sample in samples]
    assert len(fixture)==30 and len({item[1] for item in fixture})==30 and all(len(v)==5 for v in selection["cohorts"].values())
    fixture += [("regression",code,None,"既有三阶段回归") for code in selection["regressions"]]
    clock = datetime.now(funds.SHANGHAI)
    request = RequestPacer()
    try:
        catalog_body = request(funds.CATALOG_URL)
        catalog = funds.parse_catalog(catalog_body)
        catalog_error = None
    except (ValueError,OSError) as error:
        catalog_body, catalog, catalog_error = None, {}, failure(error)
    catalog_labels = {item[0]:item[3] for item in funds.assignment(catalog_body,"r")
                      if isinstance(item,list) and len(item)>=5} if catalog_body else {}
    profile_route, preflight = None, []
    for endpoint in PROFILE_URLS:
        url = endpoint.format(fixture[0][1])
        try:
            probe = catalog_profile(request(url),fixture[0][1],url)
        except (ValueError,OSError) as error:
            probe = failure(error)
        preflight.append({"url":url,"result":probe})
        if probe.get("status") == "matched":
            profile_route = endpoint
            break
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
        info["profile"] = {"status":"provider_unavailable"}
        if profile_route:
            url = profile_route.format(code)
            try:
                info["profile"] = catalog_profile(request(url),code,url)
            except (ValueError,OSError) as error:
                info["profile"] = failure(error)
        return info

    with ThreadPoolExecutor(max_workers=2) as executor:
        captured = list(executor.map(capture,fixture))
    batch_seconds = round(monotonic()-begin,2)
    report = {"baseline":selection["baseline"],"at":clock.isoformat(),"catalog_count":len(catalog),
              "catalog_error":catalog_error,"profile_preflight":preflight,"batch_seconds":batch_seconds,"funds":[]}

    disclosures = json.loads(DISCLOSURES.read_text())
    replay_histories = {}
    browser_candidates = []
    with TemporaryDirectory() as temp:
        baseline = Path(temp)
        archive = subprocess.check_output(["git","archive",selection["baseline"],"stock_analysis","web"],cwd=ROOT)
        with tarfile.open(fileobj=BytesIO(archive)) as snapshot:
            snapshot.extractall(baseline,filter="data")
        spec = importlib.util.spec_from_file_location("stock_analysis.pinned_funds",baseline/"stock_analysis/funds.py")
        pinned = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pinned)
        catalogs = {"baseline":pinned.parse_catalog(catalog_body) if catalog_body else {}, "current":catalog}

        for (group,code,label,reason), incoming in zip(fixture,captured):
            profile = incoming["profile"]
            confirmed_start = selection["confirmed_share_starts"].get(code)
            inception = confirmed_start[0] if confirmed_start else profile.get("inception")
            obj = {"code":code,"group":group,"selection_name":label,"selection_reason":reason,
                   "catalog_label":catalog_labels.get(code),"confirmed_share_start":confirmed_start,
                   "catalog":catalog.get(code),"profile":profile,"history_request_ms":incoming["history_ms"]}
            report["funds"].append(obj)
            if "history_error" in incoming:
                obj["history_error"] = incoming["history_error"]
                continue
            for name, path, adapter in (("baseline",baseline,pinned),("current",ROOT,funds)):
                try:
                    metadata = catalogs[name].get(code,{})
                    payload = adapter.parse_history(incoming["history"],code,metadata,incoming["retrieved_at"])
                    obj[name] = {"history":describe_history(adapter.assignment(incoming["history"],"Data_netWorthTrend"),payload),
                                 "name":payload["name"],"category":payload["category"]}
                    result = run_engine(path,payload)
                    obj[name].update(classify_window(result,payload,inception,group))
                    obj[name]["benchmark_disclosed"] = bool(payload.get("benchmark_disclosure") or payload.get("benchmark"))
                    if name == "current":
                        replay_histories[code] = incoming["history"]
                        if result["normal_frequency"] and group != "regression":
                            browser_candidates.append(payload)
                    if code in disclosures:
                        obj[name]["disclosure_check"] = disclosure_check(path,payload,disclosures[code])
                except (ValueError,TypeError,OSError,subprocess.SubprocessError) as error:
                    obj[name] = {"error":failure(error)}
    report["coverage"] = {label:coverage(report["funds"],label) for label in ("baseline","current")}
    longest = sorted(browser_candidates,key=lambda item:len(item["rows"]), reverse=True)[:2]
    try:
        report["operational"] = measure_interactions(ROOT,catalog_body,replay_histories,longest)
    except (RuntimeError, AssertionError, subprocess.SubprocessError, OSError) as error:
        report["operational"] = {"status":"failed", "error":str(error)[:850]}
    return report


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,required=True)
    args = parser.parse_args()
    report = run()
    args.output.write_text(json.dumps(report,ensure_ascii=False,allow_nan=False,indent=2)+"\n",encoding="utf8")
    parsed = sum("history" in row.get("current",{}) for row in report["funds"] if row["group"]!="regression")
    print(f"Fund histories validated: {parsed}/30. Aggregate audit: {args.output}")


if __name__ == "__main__":
    main()
