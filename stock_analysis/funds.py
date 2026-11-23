"""Personal fund-data retrieval and data-only parsing for the separate funds UI."""
from concurrent.futures import Future
from datetime import date, datetime, timezone
from functools import lru_cache
from pathlib import Path
from threading import Lock
from urllib.error import URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zoneinfo import ZoneInfo
import argparse
import csv
import json
import math
import re
import sys


CATALOG_URL = "https://fund.eastmoney.com/js/fundcode_search.js"
HISTORY_URL = "https://fund.eastmoney.com/pingzhongdata/{code}.js"
MAX_RESPONSE = 4_000_000
CODE = re.compile(r"[0-9]{6}")
SHANGHAI = ZoneInfo("Asia/Shanghai")
CASH_PLACEHOLDER = re.compile(r"(?:分红[：:])?每(?:[1-9][0-9]*)?份(?:基金份额)?派现金元")
SPLIT_PLACEHOLDER = re.compile(r"(?:拆分[：:]|折算[：:])?每(?:[1-9][0-9]*)?份(?:基金份额)?折算(?:为)?份")
NAV_ROUNDING_UNIT = 0.0001
INFLIGHT = {}
INFLIGHT_LOCK = Lock()


def coalesce(key, operation):
    """Share an active fetch. Completed histories and errors are not cached."""
    with INFLIGHT_LOCK:
        pending = INFLIGHT.get(key)
        if pending is None:
            pending = INFLIGHT[key] = Future()
            leader = True
        else:
            leader = False
    if not leader:
        return pending.result()
    try:
        result = operation()
        pending.set_result(result)
        return result
    except BaseException as error:
        pending.set_exception(error)
        raise
    finally:
        with INFLIGHT_LOCK:
            del INFLIGHT[key]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def download(url):
    opener = build_opener(NoRedirect())
    request = Request(url, headers={"Accept": "application/javascript, text/plain, */*"})
    with opener.open(request, timeout=8) as response:
        body = response.read(MAX_RESPONSE + 1)
    if len(body) > MAX_RESPONSE:
        raise ValueError("基金数据源响应超出限制。")
    return body.decode("utf-8-sig")


def assignment(text, name, optional=False):
    """Parse a JSON value from a named JavaScript assignment without executing it."""
    # Keep the semicolon in the consumed tail check so a literal followed by an
    # expression or a function cannot be mistaken for a supported JSON value.
    match = re.search(r"(?:^|[;\n]|\*/)\s*(?:(?:var|let|const)\s+)?" + re.escape(name) + r"\s*=\s*", text)
    if not match:
        if optional:
            return None
        raise ValueError(f"数据源缺少字段 {name}。")
    value, size = json.JSONDecoder().raw_decode(text[match.end():])
    tail = text[match.end() + size:].lstrip()
    if tail and not tail.startswith(";"):
        raise ValueError(f"数据源字段 {name} 不是 JSON 常量。")
    return value


def category_for(label):
    label = label.strip().upper()
    for text, category in (
        ("QDII", "qdii"), ("货币", "money"), ("FOF", "fof"),
        ("指数", "index"),
    ):
        if text in label:
            return category
    for prefix, category in (("股票", "stock"), ("混合", "mixed"), ("债券", "bond")):
        if label.startswith(prefix):
            return category
    return "other" if label.strip() else "unknown"


def is_off_market(name, label=""):
    title = name.upper()
    return not (
        "REIT" in title or "场内" in label or "封闭式" in label
        or ("ETF" in title and "联接" not in title and "连接" not in title and "FOF" not in title)
    )


def parse_catalog(text):
    values = assignment(text, "r")
    if not isinstance(values, list):
        raise ValueError("基金目录格式无效。")
    records = {}
    for value in values:
        if (not isinstance(value, list) or len(value) < 5
                or not all(isinstance(item, str) for item in value[:5])):
            continue
        code, short, name, label, pinyin = value[:5]
        if CODE.fullmatch(code) and name.strip() and is_off_market(name, label):
            records[code] = {"code": code, "name": name.strip(), "category": category_for(label),
                             "alias": f"{short} {pinyin}"}
    if not records:
        raise ValueError("基金目录没有可用记录。")
    return records


@lru_cache(maxsize=2)
def catalog_for_day(day):
    # Only the metadata directory is cached in the local process.
    return parse_catalog(download(CATALOG_URL))


def current_catalog():
    day = datetime.now(SHANGHAI).date()
    return coalesce(("catalog", day), lambda: catalog_for_day(day))


def number(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def timestamp_day(value):
    if not number(value) or value < 0:
        raise ValueError("基金数据源日期格式无效。")
    return datetime.fromtimestamp(value / 1000, SHANGHAI).date().isoformat()


def positive(value):
    return number(value) and value > 0


def event_text(value):
    if not isinstance(value, str):
        return None
    return re.sub(r"\s+", "", value).rstrip("。；;")


def nav_event(value):
    """Return cash per old share and new shares per old share when explicit."""
    content = event_text(value)
    if content is None:
        return None
    if content == "":
        return (0.0, 1.0) if value.strip() == "" else None
    content = re.sub(r"^(?:分红|拆分|折算)[：:]", "", content)
    cash = re.fullmatch(r"每(?:(\d+(?:\.\d+)?)?)份(?:基金份额)?派现金(\d+(?:\.\d+)?)元", content)
    if cash:
        shares = float(cash[1] or 1)
        amount = float(cash[2])
        return (amount / shares, 1.0) if positive(shares) and number(amount) else None
    split = re.fullmatch(r"每(?:(\d+(?:\.\d+)?)?)份(?:基金份额)?折算(?:为)?(\d+(?:\.\d+)?)份", content)
    if split:
        old = float(split[1] or 1)
        new = float(split[2])
        return (0.0, new / old) if positive(old) and positive(new) else None
    return None


def growth_percent(value):
    if isinstance(value, str) and re.fullmatch(r"[+-]?[0-9]+(?:\.[0-9]+)?%?", value.strip()):
        value = float(value.strip().rstrip("%"))
    return value if number(value) else None


def agrees_at_nav_precision(adjusted_nav, previous_nav, growth):
    # Use a four-place NAV / two-place % guard even if a historical NAV is coarser.
    tolerance = 0.00005 + NAV_ROUNDING_UNIT * (1 + abs(growth / 100) / 2) / previous_nav
    return abs(adjusted_nav / previous_nav - 1 - growth / 100) <= tolerance


@lru_cache(maxsize=1)
def event_evidence():
    path = Path(__file__).with_name("fund_event_evidence.json")
    document = json.loads(path.read_text(encoding="utf-8"))
    if document.get("schema_version") != 1:
        raise ValueError("基金事件证据版本不受支持。")
    return document["events"]


def disclosed_event(code, day, label):
    if not label:
        return None
    evidence = event_evidence().get(code, {}).get(day)
    if evidence is None:
        return None
    if CASH_PLACEHOLDER.fullmatch(label):
        amount = evidence.get("cash_per_share")
        if positive(amount):
            return (amount, 1.0), evidence["source"]
    if SPLIT_PLACEHOLDER.fullmatch(label):
        factor = evidence.get("shares_per_old_share")
        if positive(factor):
            return (0.0, factor), evidence["source"]
    return None


def reconcile_cash(text, previous, nav, accumulated, growth, split_seen):
    if text is None:
        return None, "missing_event_field"
    if not CASH_PLACEHOLDER.fullmatch(text):
        return None, "unrecognized_event"
    if split_seen:
        return None, "cash_after_split"
    if previous is None or previous["accumulated_nav"] is None or accumulated is None or growth is None:
        return None, "cash_evidence_missing"
    previous_nav = previous["unit_nav"]
    cash = round((accumulated - nav) - (previous["accumulated_nav"] - previous_nav), 6)
    # Four rounded NAV values can move the offset by two last-place units.
    if cash <= 2 * NAV_ROUNDING_UNIT or not agrees_at_nav_precision(nav + cash, previous_nav, growth):
        return None, "cash_evidence_mismatch"
    return (cash, 1.0), None


@lru_cache(maxsize=1)
def official_benchmarks():
    return json.loads(Path(__file__).with_name("fund_benchmarks.json").read_text(encoding="utf-8"))


def parse_history(text, code, metadata=None, retrieved_at=None):
    if not isinstance(code, str) or not CODE.fullmatch(code):
        raise ValueError("请输入六位场外基金代码。")
    if assignment(text, "fS_code") != code:
        raise ValueError("行情源返回了不同的基金代码。")
    record = metadata or {}
    name = assignment(text, "fS_name", optional=True) or record.get("name")
    if not isinstance(name, str) or not name.strip() or not is_off_market(name):
        raise ValueError("行情源没有识别到场外基金名称。")
    actual_category = record.get("category", "unknown")
    as_of = retrieved_at or datetime.now(timezone.utc)
    latest_allowed = as_of.astimezone(SHANGHAI).date().isoformat()
    trend = assignment(text, "Data_netWorthTrend")
    if not isinstance(trend, list) or not trend or len(trend) > 24_000:
        raise ValueError("暂无确认单位净值，特殊净值产品可能需要独立接口。")
    totals = assignment(text, "Data_ACWorthTrend", optional=True)
    if totals is not None and not isinstance(totals, list):
        raise ValueError("累计净值格式无效。")
    accumulated = {}
    for item in totals or []:
        if isinstance(item, list) and len(item) == 2 and positive(item[1]):
            day = timestamp_day(item[0])
            if day in accumulated:
                raise ValueError(f"累计净值日期重复 {day}。")
            accumulated[day] = item[1]
    rows = []
    index = 1.0
    split_seen = False
    for item in trend:
        if not isinstance(item, dict) or not positive(item.get("y")):
            raise ValueError("单位净值无效。")
        day = timestamp_day(item.get("x"))
        if day > latest_allowed or (rows and day <= rows[-1]["date"]):
            raise ValueError(f"净值日期未来、重复或非递增 {day}。")
        nav = item["y"]
        value = item.get("unitMoney")
        event = nav_event(value)
        label = event_text(value)
        split_seen |= bool(label and re.search(r"拆分|折算|合并", label)) or bool(event and event[1] != 1.0)
        growth = growth_percent(item.get("equityReturn"))
        previous = rows[-1] if rows else None
        amount_source = "explicit" if event and event[0] else None
        issue = None
        evidence_url = None
        if previous and event is None:
            disclosure = disclosed_event(code, day, label)
            if disclosure:
                (cash, split), evidence_url = disclosure
                if growth is not None and agrees_at_nav_precision(nav * split + cash, previous["unit_nav"], growth):
                    event = (cash, split)
                    amount_source = "fund_disclosure" if cash else None
                else:
                    issue = "disclosed_event_growth_mismatch"
            else:
                event, issue = reconcile_cash(label, previous, nav, accumulated.get(day), growth, split_seen)
                if event:
                    amount_source = "cumulative_nav_reconciled"
        cash, split = event if event else (None, None)
        index_value = None
        if previous is None:
            index_value = index
        elif event:
            previous_nav = previous["unit_nav"]
            multiplier = (nav * split + cash) / previous_nav
            if growth is not None and not math.isclose(multiplier - 1, growth / 100, rel_tol=0, abs_tol=0.005):
                issue = "growth_mismatch"
            elif positive(multiplier * index):
                index *= multiplier
                index_value = index
            else:
                issue = "invalid_multiplier"
        rows.append({"date": day, "unit_nav": nav, "accumulated_nav": accumulated.get(day),
                     "return_index": index_value, "cash_distribution": cash, "split_factor": split,
                     "cash_distribution_source": amount_source, "return_issue": issue,
                     "event_evidence": evidence_url})
    ambiguous = sum(row["return_issue"] is not None for row in rows)
    inception = record.get("inception")
    if inception and rows[0]["date"] < inception:
        raise ValueError("净值早于基金成立日。")
    daily = actual_category in {"stock", "mixed", "bond", "index"} and len(rows) >= 2
    return {
        "schema_version": 1, "kind": "off_market_fund", "code": code, "name": name.strip(),
        "category": actual_category, "inception": inception, "manager": record.get("manager"),
        "valuation_frequency": "daily" if daily else None,
        "return_basis": "event_reinvested", "return_note": (
            f"{ambiguous} 个转折点的分红、折算或净值增长率需要核实，跨越该点的区间总回报不可计算。"
            if ambiguous else "使用确认日净值、现金分红和份额折算构造总回报。"
        ),
        "source": {"name": "天天基金 / 东方财富", "url": f"https://fund.eastmoney.com/{code}.html",
                   "method": "确认单位净值及净值序列中的现金分红 / 份额折算",
                   "retrieved_at": as_of.isoformat()},
        "rows": rows, "benchmark": official_benchmarks().get(code),
    }


def load_fund(code):
    if not isinstance(code, str) or not CODE.fullmatch(code):
        raise ValueError("请输入六位场外基金代码。")
    return coalesce(("history", code), lambda: fetch_fund(code))


def fetch_fund(code):
    meta = {}
    try:
        meta = current_catalog().get(code, {})
    except (URLError, ValueError, TimeoutError):
        pass  # A directory outage is not a substitute for known classification.
    return parse_history(download(HISTORY_URL.format(code=code)), code, meta)


def search_funds(term):
    word = term.strip().lower()
    if not word or len(word) > 64:
        raise ValueError("请输入不超过 64 个字符的基金名称或代码。")
    order = sorted(current_catalog().values(), key=lambda row: (row["code"] != word, row["code"]))
    return [row for row in order if any(word in row[field].lower() for field in ("code", "name", "alias"))][:16]


def parse_disclosed_csv(stream, code, name, source_name, source_url, category="unknown",
                        manager=None, inception=None, retrieved_at=None, daily_nav=False):
    """Import NAV observations obtained from a cited report or authorized export."""
    if not CODE.fullmatch(code) or not name.strip() or not source_name.strip() or not source_url.startswith("https://"):
        raise ValueError("需提供六位基金代码、名称及 HTTPS 披露出处。")
    if not is_off_market(name):
        raise ValueError("该标的不能作为场外基金导入。")
    as_of = retrieved_at or datetime.now(timezone.utc)
    last_day = as_of.astimezone(SHANGHAI).date().isoformat()
    if inception and date.fromisoformat(inception).isoformat() != inception:
        raise ValueError("成立日期必须采用 YYYY-MM-DD。")
    reader = csv.DictReader(stream)
    if not {"date", "unit_nav"}.issubset(reader.fieldnames or []):
        raise ValueError("CSV 缺少 date 或 unit_nav。")
    seen = set()
    rows = []
    for row in reader:
        value_date = row.get("date") or ""
        if (date.fromisoformat(value_date).isoformat() != value_date or value_date in seen
                or value_date > last_day or (inception and value_date < inception)):
            raise ValueError(f"净值日期重复或越界 {value_date}。")
        parsed = {key: float(row[key]) if row.get(key) else None
                  for key in ("unit_nav", "accumulated_nav", "return_index")}
        if not positive(parsed["unit_nav"]) or any(v is not None and not positive(v) for v in parsed.values()):
            raise ValueError(f"净值或总回报指数无效 {value_date}。")
        seen.add(value_date)
        rows.append({"date": value_date, **parsed})
        if len(rows) > 24_000:
            raise ValueError("CSV 超出 24000 条记录。")
    if not rows:
        raise ValueError("CSV 不包含确认净值。")
    has_total = any(row["return_index"] is not None for row in rows)
    return {
        "schema_version": 1, "kind": "off_market_fund", "code": code, "name": name.strip(),
        "category": category, "inception": inception, "manager": manager,
        "return_basis": "adjusted_nav" if has_total else "unavailable",
        "return_note": "引用 CSV 的复权总回报指数。" if has_total else "仅有确认单位净值与累计净值，缺少总回报口径。",
        "source": {"name": source_name, "url": source_url, "method": "个人导入披露净值 CSV",
                   "retrieved_at": as_of.isoformat()},
        "rows": sorted(rows, key=lambda row: row["date"]),
        "valuation_frequency": "daily" if daily_nav else None,
        "benchmark": official_benchmarks().get(code),
    }


def attach_benchmark_data(fund, imported):
    if imported.get("code") != fund["code"]:
        raise ValueError("补充基准数据的基金代码不匹配。")
    current = fund.get("benchmark")
    if current is None or not isinstance(imported.get("series"), list):
        raise ValueError("需提供已核验基金的成分点位序列。")
    return {**fund, "benchmark": {**current, "series": imported["series"]}}


def main():
    parser = argparse.ArgumentParser(description="Generate a personal, local fund JSON import")
    parser.add_argument("code", help="Six-digit off-market fund code")
    inputs = parser.add_mutually_exclusive_group()
    inputs.add_argument("--snapshot", type=Path, help="Locally saved source script; only JSON constants are parsed")
    inputs.add_argument("--nav-csv", type=Path, help="Officially disclosed or authorized confirmed NAV CSV")
    parser.add_argument("--catalog", type=Path, help="Locally saved source catalogue")
    parser.add_argument("--name", help="Disclosed share-class name for CSV imports")
    parser.add_argument("--source-name", help="Disclosing entity for CSV imports")
    parser.add_argument("--source-url", help="HTTPS disclosure URL for CSV imports")
    parser.add_argument("--category", default="unknown", choices=["stock", "mixed", "bond", "index", "qdii", "money", "fof", "other", "unknown"])
    parser.add_argument("--manager", help="Disclosed fund management company")
    parser.add_argument("--inception", help="Disclosed share-class inception date")
    parser.add_argument("--daily-nav", action="store_true", help="Declare CSV as confirmed daily valuations")
    parser.add_argument("--benchmark-data", type=Path, help="Local authorized benchmark component levels JSON")
    parser.add_argument("--risk-free-start", type=date.fromisoformat, help="Opt in to local ChinaBond 3-month rates from YYYY-MM-DD")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not CODE.fullmatch(args.code):
        parser.error("请输入六位场外基金代码。")
    try:
        if args.nav_csv:
            if not all((args.name, args.source_name, args.source_url)):
                parser.error("--nav-csv 需要 --name、--source-name 和 --source-url。")
            if args.nav_csv.stat().st_size > MAX_RESPONSE:
                raise ValueError("本地源文件过大。")
            with args.nav_csv.open(encoding="utf-8-sig", newline="") as stream:
                data = parse_disclosed_csv(stream, args.code, args.name, args.source_name, args.source_url,
                                           args.category, args.manager, args.inception, daily_nav=args.daily_nav)
        elif args.snapshot:
            with args.snapshot.open("rb") as stream:
                body = stream.read(MAX_RESPONSE + 1)
            if len(body) > MAX_RESPONSE:
                raise ValueError("本地源文件过大。")
            metadata = parse_catalog(args.catalog.read_text(encoding="utf-8-sig")).get(args.code) if args.catalog else None
            modified_at = datetime.fromtimestamp(args.snapshot.stat().st_mtime, timezone.utc)
            data = parse_history(body.decode("utf-8-sig"), args.code, metadata, modified_at)
        else:
            data = load_fund(args.code)
        if args.benchmark_data:
            if args.benchmark_data.stat().st_size > MAX_RESPONSE:
                raise ValueError("补充基准数据文件过大。")
            imported = json.loads(args.benchmark_data.read_text(encoding="utf-8-sig"))
            if not isinstance(imported, dict):
                raise ValueError("补充基准数据必须为 JSON 对象。")
            data = attach_benchmark_data(data, imported)
        if args.risk_free_start:
            from .fund_rates import load_chinabond_rates
            end = date.fromisoformat(data["rows"][-1]["date"])
            try:
                data = {**data, "risk_free": load_chinabond_rates(args.risk_free_start, end, download)}
            except (OSError, ValueError, TimeoutError) as error:
                print(f"历史无风险利率不可用：{error}", file=sys.stderr)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, allow_nan=False)
        print(args.output)
    except (OSError, ValueError, OverflowError) as exc:
        parser.exit(1, f"基金数据不可用：{exc}\n")


if __name__ == "__main__":
    main()
