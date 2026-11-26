"""Build a relative-path Pages site using the existing real-history demo engine."""
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from urllib.parse import urlsplit
import argparse
import hashlib
import html
import json
import os
import shutil

import exchange_calendars as xcals
import pandas as pd

from .web import ROOT, export_demo, load_demo
from . import funds
from .sector_data import read_catalog


MODEL_MODULES = ("web/engine.mjs", "web/providers.mjs", *(
    f"web/funds/{name}.mjs" for name in (
        "benchmark", "chart-data", "data", "nav-source", "performance", "providers",
        "risk-free", "sector-browser", "sector-model",
    )
))
SNAPSHOT_TRANSPORT = {"compatibility.mjs", "details.mjs", "public.mjs", "service.mjs", "site-gateway.mjs", "store.mjs", "valuation.mjs", "worker.mjs"}


def snapshot_modules():
    return sorted((ROOT / "worker/snapshots").glob("*.mjs"))


def analysis_model_version(inputs):
    paths = [ROOT / path for path in MODEL_MODULES]
    paths += [path for path in snapshot_modules() if path.name not in SNAPSHOT_TRANSPORT]
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.relative_to(ROOT).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    digest.update(json.dumps(inputs, sort_keys=True, ensure_ascii=False, allow_nan=False).encode())
    return "analysis-v1-" + digest.hexdigest()[:20]


def export_snapshot_runtime(destination, pages):
    """Stage the exact engine and inputs from this build for a separately hosted Worker."""
    destination.mkdir(parents=True, exist_ok=False)
    for path in [*(ROOT / name for name in MODEL_MODULES), ROOT / "web/funds/valuation-source.mjs", *snapshot_modules()]:
        target = destination / path.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    assets = destination / "assets"
    assets.mkdir()
    for name in ("calendar.json", "fund-config.json", "build-info.json"):
        shutil.copyfile(pages / name, assets / name)


def build_pages(destination, calendar_end=None, fund_index_snapshot=None, snapshot_service=None,
                snapshot_runtime_output=None, snapshot_reference=None):
    if snapshot_runtime_output:
        runtime = Path(snapshot_runtime_output).resolve()
        pages = Path(destination).resolve()
        if runtime == pages or pages in runtime.parents or runtime in pages.parents:
            raise ValueError("快照 Worker 与 Pages 必须输出到独立目录。")
        if fund_index_snapshot:
            raise ValueError("快照 Worker 尚不支持浏览器专用的静态指数输入。")
    now = datetime.now(ZoneInfo("UTC"))
    model_day = now.astimezone(funds.SHANGHAI).date().isoformat()
    if snapshot_reference is not None:
        if not snapshot_service or calendar_end or fund_index_snapshot or snapshot_runtime_output:
            raise ValueError("复用已部署 Worker 时须提供服务来源，并使用其模型输入。")
        if snapshot_reference["schema_version"] != 1:
            raise ValueError("已部署 Worker 的结构版本与 Pages 不兼容。")
        calendar_end = snapshot_reference["calendar_end"]
        model_day = datetime.fromisoformat(snapshot_reference["generated_at_utc"]).astimezone(funds.SHANGHAI).date().isoformat()
    # Calendar has an explicit validity window; it is never extrapolated in JS.
    end = calendar_end or min(now.date() + timedelta(days=31), now.date().replace(month=12, day=31)).isoformat()
    start = "2000-01-01"
    calendar = xcals.get_calendar("XSHG", start=pd.Timestamp(start) - pd.Timedelta(days=14), end=end)
    dataset = load_demo()
    dataset.update(snapshot=True, generated_at_utc=now.isoformat())
    output = export_demo(destination, dataset)
    service_attribute = ""
    if snapshot_service:
        service = urlsplit(snapshot_service)
        local = service.scheme == "http" and service.hostname in ("localhost", "127.0.0.1")
        if ((service.scheme != "https" and not local) or not service.hostname or service.username
                or service.password or service.path not in ("", "/") or service.query or service.fragment):
            raise ValueError("快照服务必须是 HTTPS 来源，本地验收可使用回环 HTTP。")
        service_attribute = f' data-analysis-origin="{html.escape(snapshot_service, quote=True)}"'
    payload = {
        "schema_version": 1, "start": start, "end": end,
        "calendar": "exchange_calendars:XSHG", "version": xcals.__version__,
        "generated_at_utc": now.isoformat(),
        "sessions": calendar.sessions[(calendar.sessions >= pd.Timestamp(start)) & (calendar.sessions <= pd.Timestamp(end))].strftime("%Y-%m-%d").tolist(),
        "suspensions": json.loads((ROOT / "stock_analysis/suspensions.json").read_text(encoding="utf-8")),
    }
    (output / "calendar.json").write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    from .fund_benchmark_identification import benchmark_page_disclosures, reviewed_disclosures

    day = now.astimezone(funds.SHANGHAI).date().isoformat()
    reviewed = reviewed_disclosures()
    # Disclosure-only additions belong to the website, outside the shared model inputs.
    display_codes = {code for code, record in reviewed.items() if record.get("display_only")}
    config = {"schema_version": 1, "as_of": model_day, "events": funds.event_evidence(),
              "benchmarks": {code: funds.benchmark_metadata(code, model_day)
                             for code in sorted(funds.official_benchmarks().keys() | (reviewed.keys() - display_codes))},
              "indices": read_catalog(),
              "holdings": json.loads((ROOT / "research/sector_holdings_evidence.json").read_text(encoding="utf-8"))}
    snapshot = None
    if fund_index_snapshot:
        config["index_snapshot"] = "fund-index-snapshot.json"
        snapshot = json.loads(Path(fund_index_snapshot).read_text(encoding="utf-8"))
        if (snapshot.get("schema_version") != 1 or not isinstance(snapshot.get("indices"), dict)
                or any(code not in config["indices"] or code.startswith(("000", "399"))
                       for code in snapshot["indices"])):
            raise ValueError("基金静态行情只接收已登记且股票接口未映射的特殊指数。")
        (output / config["index_snapshot"]).write_text(json.dumps(snapshot, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    (output / "fund-config.json").write_text(json.dumps(config, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    (output / "fund-benchmark-disclosures.json").write_text(
        json.dumps(benchmark_page_disclosures(day), ensure_ascii=False, allow_nan=False),
        encoding="utf-8",
    )
    model_version = analysis_model_version({
        "calendar": {key: value for key, value in payload.items() if key != "generated_at_utc"},
        "fund_config": {key: value for key, value in config.items() if key != "as_of"},
        "special_indices": snapshot,
    })
    if snapshot_reference is not None and model_version != snapshot_reference["analysis_model_version"]:
        raise ValueError(f"当前源码生成的模型 {model_version} 与已部署 Worker 不兼容。")
    attributes = f'data-mode="pages" data-analysis-model="{model_version}"{service_attribute}'
    for filename in ("index.html", "funds.html"):
        page = output / filename
        page.write_text(page.read_text(encoding="utf-8").replace(
            '<html lang="zh-CN">', f'<html lang="zh-CN" {attributes}>'), encoding="utf-8")
    (output / "build-info.json").write_text(json.dumps({
        "schema_version": 1, "commit_sha": os.getenv("GITHUB_SHA", "local-unversioned"),
        "generated_at_utc": now.isoformat(), "calendar_end": end,
        "snapshot_last_date": dataset["rows"][-1]["date"],
        "analysis_model_version": model_version,
    }, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    (output / ".nojekyll").touch()
    if snapshot_runtime_output:
        export_snapshot_runtime(runtime, output)
    return output


def main():
    parser = argparse.ArgumentParser(description="Build the GitHub Pages site")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fund-index-snapshot", type=Path)
    parser.add_argument("--snapshot-service")
    parser.add_argument("--snapshot-runtime-output", type=Path)
    parser.add_argument("--snapshot-reference", type=Path, help="Build metadata exported with the deployed Worker")
    args = parser.parse_args()
    reference = json.loads(args.snapshot_reference.read_text(encoding="utf-8")) if args.snapshot_reference else None
    print(build_pages(args.output, fund_index_snapshot=args.fund_index_snapshot,
                      snapshot_service=args.snapshot_service,
                      snapshot_runtime_output=args.snapshot_runtime_output, snapshot_reference=reference))


if __name__ == "__main__":
    main()
