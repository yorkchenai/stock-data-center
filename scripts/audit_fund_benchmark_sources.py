"""Capture benchmark candidate fields from the fixed phase-four panel."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
from time import sleep

from stock_analysis.fund_benchmark_sources import Candidate, PROFILES, candidate_record, read_candidate

ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "tests/fixtures/fund_generalization_panel.json"


def sweep(source, panel):
    records = {}
    restriction = None
    for code in panel:
        if restriction:
            candidate = Candidate(source, code, PROFILES[source].format(code), "not_requested_after_restriction",
                                  datetime.now(timezone.utc).isoformat(), reason=restriction)
        else:
            candidate = read_candidate(source, code)
            if candidate.status == "access_restricted":
                restriction = f"source returned HTTP {candidate.http_status}; stopped"
            sleep(.8)  # Serial per source, no retry and no access-control bypass.
        records[code] = candidate_record(candidate)
    return source, records


def capture():
    fixture = json.loads(PANEL.read_text(encoding="utf-8"))
    panel = {code: {"group":group,"name":name} for group, samples in fixture["cohorts"].items()
             for code, name, _ in samples}
    if len(panel) != 30:
        raise ValueError("Phase-four audit panel must remain exactly 30 distinct fund codes")
    with ThreadPoolExecutor(max_workers=len(PROFILES)) as executor:
        sources = dict(executor.map(lambda source:sweep(source, panel),PROFILES))
    return {"schema_version":1,"captured_at":datetime.now(timezone.utc).isoformat(),"panel":panel,"sources":sources}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(capture(), ensure_ascii=False, indent=2)+"\n",encoding="utf-8")


if __name__ == "__main__":
    main()
