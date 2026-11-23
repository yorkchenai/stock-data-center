"""Read benchmark candidates from public fund profiles. Never upgrades trust."""
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from http.client import HTTPException
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

from bs4 import BeautifulSoup

from .funds import CODE, NoRedirect

MAX_PAGE_BYTES = 4_000_000
PROFILES = {
    "eastmoney": "https://fundf10.eastmoney.com/jbgk_{}.html",
    "sina": "https://stock.finance.sina.com.cn/fundInfo/view/FundInfo_JJGK.php?symbol={}",
}
BENCHMARK_LABELS = {"业绩比较基准", "基金业绩比较基准", "基金比较基准", "比较基准", "业绩基准"}
EMPTY_FIELDS = {"", "--", "—", "-", "暂无", "暂无数据", "暂无信息", "无", "不适用", "N/A", "无业绩比较基准"}


@dataclass(frozen=True)
class Candidate:
    source: str
    fund_code: str
    source_url: str
    status: str
    retrieved_at: str
    formula: str | None = None
    tracking_target: str | None = None
    fund_type: str | None = None
    contract_date_text: str | None = None
    http_status: int | None = None
    reason: str | None = None


def profile_labels(document):
    # Both profiles use key/value cells. Keep exact labels to avoid treating
    # a style classification, a tracking index, or a peer index as a benchmark.
    fields = defaultdict(list)
    for row in document.select("tr"):
        cells = row.find_all(("th", "td"), recursive=False)
        for label, cell in zip(cells, cells[1:]):
            key = re.sub(r"\s+", "", label.get_text().strip()).rstrip("：:")
            if key:
                value = " ".join(cell.stripped_strings).strip()
                if value:
                    fields[key].append(value)
    return fields


def parse_profile(source, code, body, retrieved_at):
    url = PROFILES[source].format(code)
    document = BeautifulSoup(body, "html.parser")
    labels = profile_labels(document)
    fields = {key: values[0] for key, values in labels.items()}
    codes = set()
    found_primary_identity = False
    identity_fields = ("基金代码",) if "基金代码" in fields else (
        "基金主代码", "交易代码", "基金前端代码", "基金后端代码", "基金代码(前端)", "基金代码(后端)")
    for key in identity_fields:
        if key in fields:
            codes.update(re.findall(r"(?<!\d)\d{6}(?!\d)", fields[key]))
            found_primary_identity = True
    if not found_primary_identity:
        # Sina profiles expose the selected share in the page title even
        # when the selected page omits an explicit fund-code cell.
        title = document.title.get_text() if document.title else ""
        found = re.search(r"[（(](\d{6})[）)]", title)
        if found:
            codes.add(found[1])
    if code not in codes:
        return Candidate(source, code, url, "identity_unverified", retrieved_at,
                         http_status=200, reason="profile share code missing or different")
    formulas = [value for key, values in labels.items() if key in BENCHMARK_LABELS
                for value in values if value not in EMPTY_FIELDS]
    status = "found" if formulas else "field_missing"
    if len(set(formulas)) > 1:
        return Candidate(source, code, url, "field_conflict", retrieved_at, http_status=200,
                         reason="multiple benchmark values in the same profile")
    return Candidate(source, code, url, status, retrieved_at, formula=formulas[0] if formulas else None,
                     tracking_target=fields.get("跟踪标的") or fields.get("跟踪指数"),
                     fund_type=fields.get("基金类型") or fields.get("投资类型"),
                     contract_date_text=next((v for k, v in fields.items()
                         if k.startswith(("成立日期","基金合同生效日","基金成立日"))), None),
                     http_status=200)


def read_candidate(source, code, http=None):
    if not isinstance(code, str) or not CODE.fullmatch(code):
        raise ValueError("Expected a six-digit fund share code")
    url = PROFILES[source].format(code)
    now = datetime.now(timezone.utc).isoformat()
    request = Request(url, headers={"Accept":"text/html"})
    get = build_opener(NoRedirect()).open if http is None else http
    try:
        with get(request, timeout=8) as response:
            if response.headers.get_content_type() != "text/html":
                return Candidate(source, code, url, "unexpected_response", now, http_status=response.status)
            raw = response.read(MAX_PAGE_BYTES + 1)
            charset = response.headers.get_content_charset()
        if len(raw) > MAX_PAGE_BYTES:
            return Candidate(source, code, url, "unexpected_response", now, http_status=200, reason="profile too large")
        encodings = [charset] if charset else (["utf-8", "gb18030"] if source == "sina" else ["utf-8"])
        for encoding in encodings:
            try:
                return parse_profile(source, code, raw.decode(encoding), now)
            except (UnicodeDecodeError, LookupError):
                continue
        return Candidate(source, code, url, "unexpected_response", now, http_status=200, reason="unrecognized charset")
    except HTTPError as error:
        status = "access_restricted" if error.code in {401, 403, 429} else "http_error"
        return Candidate(source, code, url, status, now, http_status=error.code)
    except (OSError, URLError, HTTPException) as error:
        return Candidate(source, code, url, "network_error", now, reason=type(error).__name__)


def candidate_record(candidate):
    return {key:value for key,value in asdict(candidate).items() if value is not None}
