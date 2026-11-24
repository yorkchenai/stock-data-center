"""Build a relative-path Pages site using the existing real-history demo engine."""
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
import argparse
import json
import os

import exchange_calendars as xcals
import pandas as pd

from .web import ROOT, export_demo, load_demo
from . import funds
from .sector_data import read_catalog


def build_pages(destination, calendar_end=None, fund_index_snapshot=None):
    now = datetime.now(ZoneInfo("UTC"))
    # Calendar has an explicit validity window; it is never extrapolated in JS.
    end = calendar_end or min(now.date() + timedelta(days=31), now.date().replace(month=12, day=31)).isoformat()
    start = "2000-01-01"
    calendar = xcals.get_calendar("XSHG", start=pd.Timestamp(start) - pd.Timedelta(days=14), end=end)
    dataset = load_demo()
    dataset.update(snapshot=True, generated_at_utc=now.isoformat())
    output = export_demo(destination, dataset)
    page = output / "index.html"
    page.write_text(page.read_text(encoding="utf-8").replace('<html lang="zh-CN">', '<html lang="zh-CN" data-mode="pages">'), encoding="utf-8")
    fund_page = output / "funds.html"
    fund_page.write_text(fund_page.read_text(encoding="utf-8").replace('<html lang="zh-CN">', '<html lang="zh-CN" data-mode="pages">'), encoding="utf-8")
    payload = {
        "schema_version": 1, "start": start, "end": end,
        "calendar": "exchange_calendars:XSHG", "version": xcals.__version__,
        "generated_at_utc": now.isoformat(),
        "sessions": calendar.sessions[(calendar.sessions >= pd.Timestamp(start)) & (calendar.sessions <= pd.Timestamp(end))].strftime("%Y-%m-%d").tolist(),
        "suspensions": json.loads((ROOT / "stock_analysis/suspensions.json").read_text(encoding="utf-8")),
    }
    (output / "calendar.json").write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    from .fund_benchmark_identification import reviewed_disclosures

    day = now.astimezone(funds.SHANGHAI).date().isoformat()
    config = {"schema_version": 1, "as_of": day, "events": funds.event_evidence(),
              "benchmarks": {code: funds.benchmark_metadata(code, day)
                             for code in sorted(funds.official_benchmarks().keys() | reviewed_disclosures().keys())},
              "indices": read_catalog(),
              "holdings": json.loads((ROOT / "research/sector_holdings_evidence.json").read_text(encoding="utf-8"))}
    if fund_index_snapshot:
        config["index_snapshot"] = "fund-index-snapshot.json"
        snapshot = json.loads(Path(fund_index_snapshot).read_text(encoding="utf-8"))
        if (snapshot.get("schema_version") != 1 or not isinstance(snapshot.get("indices"), dict)
                or any(code not in config["indices"] or code.startswith(("000", "399"))
                       for code in snapshot["indices"])):
            raise ValueError("基金静态行情只接收已登记且股票接口未映射的特殊指数。")
        (output / config["index_snapshot"]).write_text(json.dumps(snapshot, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    (output / "fund-config.json").write_text(json.dumps(config, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    (output / "build-info.json").write_text(json.dumps({
        "schema_version": 1, "commit_sha": os.getenv("GITHUB_SHA", "local-unversioned"),
        "generated_at_utc": now.isoformat(), "calendar_end": end,
        "snapshot_last_date": dataset["rows"][-1]["date"],
    }, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    (output / ".nojekyll").touch()
    return output


def main():
    parser = argparse.ArgumentParser(description="Build the GitHub Pages site")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fund-index-snapshot", type=Path)
    args = parser.parse_args()
    print(build_pages(args.output, fund_index_snapshot=args.fund_index_snapshot))


if __name__ == "__main__":
    main()
