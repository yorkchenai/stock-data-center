"""Probe fund/sector data and write only aggregate evidence, never histories."""
from argparse import ArgumentParser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
from pathlib import Path
from time import sleep


from stock_analysis import funds

# Preserve these imports for the phase-six and phase-seven research entry points.
from stock_analysis.sector_data import (
    ROOT, csi_history, read_catalog, session_index, error_status, read_with_transient_retry, collect_indices,
)

def collect_funds(start, end):
    panel = json.loads((ROOT / "research/fund_sector_panel.json").read_text())
    fixture = json.loads((ROOT / "tests/fixtures/fund_generalization_panel.json").read_text())
    catalog = funds.parse_catalog(funds.download(funds.CATALOG_URL))
    histories, report = {}, {}
    restricted = False
    for category,codes in panel.items():
        expected = {code for code,*_ in fixture["cohorts"][category]}
        if set(codes) - expected:
            raise ValueError("Study panel must come from the fixed phase-four groups")
        for code in codes:
            if restricted:
                report[code] = {"status":"not_requested_after_restriction"}
                continue
            metadata = catalog.get(code) or {}
            try:
                fund = read_with_transient_retry(lambda:funds.parse_history(
                    funds.download(funds.HISTORY_URL.format(code=code)),code,metadata))
                rows = fund["rows"]
                report[code] = {"status":"ok" if fund["category"] == ("stock" if category == "active_stock" else "mixed")
                                else "type_mismatch", "category":fund["category"], "name":fund["name"],
                                "count":len(rows), "first":rows[0]["date"], "last":rows[-1]["date"],
                                "usable_levels":sum(row["return_index"] is not None for row in rows),
                                "distribution_events":sum(bool(row["cash_distribution"]) for row in rows),
                                "unverified_events":sum(bool(row["return_issue"]) for row in rows),
                                "source_url":fund["source"]["url"]}
                if report[code]["status"] == "ok":
                    histories[code] = fund
            except (ValueError, KeyError, TypeError, OSError) as exc:
                status = error_status(exc)
                restricted = status["status"] == "access_restricted"
                report[code] = {**status, "category":metadata.get("category")}
            sleep(.6)
    return histories, report


def collect(start,end):
    with ThreadPoolExecutor(max_workers=2) as pool:
        left = pool.submit(collect_funds,start,end)
        right = pool.submit(collect_indices,start,end)
        try:
            funds_data, funds_report = left.result()
        except (ValueError, OSError) as exc:
            funds_data, funds_report = {}, {"catalog":error_status(exc)}
        index_data, index_report = right.result()
    summary = {"schema_version":1,"period":{"start":start,"end":end},
               "funds":funds_report,"indices":index_report,
               "as_of":datetime.now(funds.SHANGHAI).isoformat()}
    return funds_data,index_data,summary


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--start", default="2021-01-04")
    parser.add_argument("--end", default=datetime.now(funds.SHANGHAI).date().isoformat())
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    _,_,report = collect(args.start,args.end)
    args.output.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n")


if __name__ == "__main__":
    main()
