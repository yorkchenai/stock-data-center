import csv
import os
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SYMBOL = "000688"
START_DATE = "2020-07-01"
END_DATE = datetime.now(timezone.utc).strftime("%Y-%m-%d")
HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json,text/plain,*/*"}
EASTMONEY_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get?" + urllib.parse.urlencode({
    "secid": "1.000688", "fields1": "f1,f2,f3,f4,f5,f6",
    "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    "klt": "101", "fqt": "0", "beg": "20200701", "end": "20500101"
})
# Tencent's historical daily endpoint; returned fields vary by instrument.
TENCENT_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?" + urllib.parse.urlencode({
    "param": "sh000688,day,,,2000,qfq"
})
result = {"symbol": SYMBOL, "tested_at_utc": datetime.now(timezone.utc).isoformat(),
          "status": "failed", "attempted_sources": []}
columns = ["date", "open", "close", "high", "low", "volume_lots", "turnover_cny"]


def request_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)


def check_rows(rows):
    if len(rows) < 100:
        raise ValueError("Insufficient historical rows: " + str(len(rows)))
    dates = [row[0] for row in rows]
    if dates != sorted(set(dates)):
        raise ValueError("Dates are duplicated or not ascending")
    if dates[0] > "2020-07-31":
        raise ValueError("History does not cover July 2020")
    for row in rows:
        if len(row) != 7:
            raise ValueError("Unexpected column count")
        for value in row[1:5]:
            if float(value) <= 0:
                raise ValueError("Invalid OHLC price")
    return rows


def eastmoney():
    data = (request_json(EASTMONEY_URL).get("data") or {})
    raw = data.get("klines") or []
    rows = []
    for item in raw:
        fields = item.split(",")
        if len(fields) < 7:
            raise ValueError("Incomplete Eastmoney row")
        rows.append([fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6]])
    return check_rows(rows)


def tencent():
    payload = request_json(TENCENT_URL)
    data = payload.get("data") or {}
    item = data.get("sh000688") or {}
    raw = item.get("day") or item.get("qfqday") or []
    if not raw:
        summary = {"top_level_keys": list(payload)[:15], "data_keys": list(data)[:15], "instrument_keys": list(item)[:15], "instrument_preview": str(item)[:1200], "response_preview": str(payload)[:1800]}
        if os.getenv("FORCE_TENCENT") == "1":
            with open("tencent_response_diagnostic.json", "w", encoding="utf-8") as diagnostic:
                json.dump(summary, diagnostic, ensure_ascii=False, indent=2)
        raise ValueError("Tencent returned no day history; response shape recorded in tencent_response_diagnostic.json")
    rows = []
    for record in raw:
        # Tencent day records typically contain date, open, close, high, low, volume.
        # The endpoint does not guarantee turnover; never substitute another metric.
        if len(record) < 6:
            raise ValueError("Incomplete Tencent row")
        date, op, cl, hi, lo, vol = record[:6]
        rows.append([date, op, cl, hi, lo, vol, ""])
    return check_rows(rows)


sources = [
    ("Eastmoney historical K-line", EASTMONEY_URL, eastmoney),
    ("Tencent historical daily K-line", TENCENT_URL, tencent),
]
if os.getenv("FORCE_TENCENT") == "1":
    sources = [sources[1]]
for source, url, fetcher in sources:
    attempt_record = {"source": source, "url": url}
    result["attempted_sources"].append(attempt_record)
    for attempt in range(1, 4):
        attempt_record["attempts"] = attempt
        try:
            rows = fetcher()
            with open("kechuang50_daily.csv", "w", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle)
                writer.writerow(columns)
                writer.writerows(rows)
            result.update({"status": "success", "source": source, "rows": len(rows),
                           "first_date": rows[0][0], "last_date": rows[-1][0],
                           "volume_unit": "provider-reported volume (verify lot convention)",
                           "turnover_unit": "CNY if supplied; empty when unavailable",
                           "missing_turnover_rows": sum(not r[6] for r in rows)})
            break
        except Exception as exc:
            attempt_record["last_error"] = repr(exc)
            if attempt < 3:
                time.sleep(attempt * 3)
    if result["status"] == "success":
        break

if result["status"] != "success":
    result["error"] = "All data sources failed; inspect attempted_sources"
with open("test_result.json", "w", encoding="utf-8") as handle:
    json.dump(result, handle, ensure_ascii=False, indent=2)
print(json.dumps(result, ensure_ascii=False, indent=2))
if result["status"] != "success":
    sys.exit(1)
