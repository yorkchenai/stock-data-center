import csv
import io
import json
import time
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SYMBOL = "000688"
URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get?" + urllib.parse.urlencode({
    "secid": "1.000688", "fields1": "f1,f2,f3,f4,f5,f6",
    "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    "klt": "101", "fqt": "0", "beg": "20200701", "end": "20500101"
})
request = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"})
result = {"symbol": SYMBOL, "tested_at_utc": datetime.now(timezone.utc).isoformat(), "source": "Eastmoney historical K-line", "url": URL}
try:
    # Retry transient disconnects, timeouts and upstream 5xx responses.
    # A retry cannot bypass provider-side blocking.
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                body = response.read()
                result["http_status"] = response.status
            result["attempts"] = attempt
            break
        except Exception as exc:
            result["attempts"] = attempt
            result["last_request_error"] = repr(exc)
            if attempt == 3:
                raise
            time.sleep(attempt * 3)
    payload = json.loads(body)
    data = payload.get("data") or {}
    klines = data.get("klines") or []
    if not klines:
        raise ValueError("No klines returned: " + str(payload)[:400])
    rows = []
    for item in klines:
        fields = item.split(",")
        if len(fields) < 7:
            raise ValueError("Incomplete K-line row")
        rows.append(fields[:7])
    if len(rows) < 100:
        raise ValueError("Too few rows: " + str(len(rows)))
    with open("kechuang50_daily.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["date", "open", "close", "high", "low", "volume_lots", "turnover_cny"])
        writer.writerows(rows)
    result.update({"status": "success", "rows": len(rows), "first_date": rows[0][0], "last_date": rows[-1][0], "first_row": rows[0], "last_row": rows[-1], "volume_unit": "lots (100 shares)", "turnover_unit": "CNY"})
except Exception as exc:
    result.update({"status": "failed", "error": repr(exc)})
with open("test_result.json", "w", encoding="utf-8") as handle:
    json.dump(result, handle, ensure_ascii=False, indent=2)
print(json.dumps(result, ensure_ascii=False, indent=2))
if result["status"] != "success":
    sys.exit(1)
