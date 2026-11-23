"""Local, opt-in adapter for ChinaBond's RMB government yield observations."""
from datetime import date, datetime, timedelta, timezone
from io import StringIO
import math
import re
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import pandas as pd

HISTORY_URL = "https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery"
SOURCE_URL = "https://yield.chinabond.com.cn/cbweb-cbrc-web/cbrc/showHistory?locale=cn_ZH&mark=1"
CURVE = "中债国债收益率曲线"
SHANGHAI = ZoneInfo("Asia/Shanghai")


def parse_yield_history(html, start, end):
    """Read only the 3-month sovereign curve, in decimal annual units."""
    tables = pd.read_html(StringIO(html), match="曲线名称", header=0)
    for table in tables:
        table.columns = [re.sub(r"\s+", "", str(column)) for column in table.columns]
    matching = [table for table in tables if {"曲线名称", "日期", "3月"}.issubset(table.columns)]
    if len(matching) != 1:
        raise ValueError("中债历史收益率表列名无法核对。")
    table = matching[0]
    dates = set()
    rows = []
    for day, quote in table.loc[table["曲线名称"] == CURVE, ["日期", "3月"]].itertuples(index=False, name=None):
        observed = date.fromisoformat(str(day).strip())
        if not start <= observed <= end or observed in dates:
            raise ValueError("中债国债收益率日期重复或超出查询区间。")
        dates.add(observed)
        if pd.isna(quote) or str(quote).strip() in {"--", "—"}:
            continue
        annual_rate = float(str(quote).strip()) / 100
        if not math.isfinite(annual_rate) or annual_rate <= -1:
            raise ValueError("中债 3 个月国债收益率数值无效。")
        rows.append({"date": observed.isoformat(), "annual_rate": annual_rate})
    return sorted(rows, key=lambda row: row["date"])


def load_chinabond_rates(start, end, fetch_html, retrieved_at=None):
    """Fetch bounded calendar batches. Caller chooses opt-in personal use."""
    retrieved_at = retrieved_at or datetime.now(timezone.utc)
    if not date(2006, 3, 1) <= start <= end <= retrieved_at.astimezone(SHANGHAI).date():
        raise ValueError("利率起止日期超出可查询范围。")
    rows = []
    first = max(start - timedelta(days=10), date(2006, 3, 1))
    while first <= end:
        last = min(first + timedelta(days=359), end)
        query = urlencode({"startDate": first.isoformat(), "endDate": last.isoformat(), "gjqx": "0",
                           "qxId": "ycqx", "locale": "cn_ZH"})
        rows.extend(parse_yield_history(fetch_html(f"{HISTORY_URL}?{query}"), first, last))
        first = last + timedelta(days=1)
    if not rows or rows[-1]["date"] < start.isoformat():
        raise ValueError("查询区间内没有可用的 3 个月国债收益率。")
    return {
        "name": "中债国债收益率曲线（到期，3 个月）",
        "source": "中央国债登记结算有限责任公司 / 中债收益率曲线",
        "source_url": SOURCE_URL,
        "retrieved_at": retrieved_at.isoformat(),
        "quote_basis": "人民币 3 个月国债到期收益率，年化百分比转为小数",
        "convention": "simple_act_365f",
        "effective_from": start.isoformat(),
        "effective_to": rows[-1]["date"],
        "max_age_days": 10,
        "rows": rows,
    }
