"""Measure candidate extraction, formula agreement and official evidence on a saved panel."""
import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path

from stock_analysis.fund_benchmark_identification import identify
from stock_analysis.fund_benchmark_sources import PROFILES
from stock_analysis.funds import SHANGHAI


def complete_index_mapping(parsed):
    if not parsed or parsed["status"] != "parsed":
        return False
    indices = [item for item in parsed["components"] if item["type"] == "index"]
    return bool(indices) and all(item["mapping"]["status"] == "matched" for item in indices)


def summarize(records):
    counts = Counter()
    counts["samples"] = len(records)
    for result in records:
        candidates = result["candidates"]
        counts["with_candidate"] += any(item["formula"] for item in candidates)
        counts["parsed"] += any(item["parsed"] and item["parsed"]["status"] == "parsed" for item in candidates)
        counts["with_all_index_ids"] += any(complete_index_mapping(item["parsed"]) for item in candidates)
        counts["official_verified"] += result["official_status"] == "official_verified"
        counts["dated_effective_regime"] += result["official_status"] in {"official_verified", "official_none"}
        counts["with_confirmed_change"] += result["confirmed_change_count"] > 0
        counts["with_effective_change"] += result["effective_change_count"] > 0
        counts["engine_compatible"] += result["engine_status"] == "compatible"
        counts["history_points_available"] += result["history_points_status"] == "available"
        counts["still_needs_review"] += result["grade"] != "A"
        counts["grade_" + result["grade"]] += 1
        if result["text_agreement"] is not None:
            counts["text_pairs"] += 1
            counts["text_same"] += result["text_agreement"]
        if result["formula_agreement"] is not None:
            counts["formula_pairs"] += 1
            counts["formula_same"] += result["formula_agreement"]
        if result["confirmed_change_count"]:
            for item in candidates:
                status = item["official_comparison"]
                if status in {"matches_official", "stale", "premature", "differs_from_official"}:
                    counts["official_change_candidates_compared"] += 1
                    counts["official_change_" + status] += 1
    return dict(counts)


def audit(captured):
    if captured["schema_version"] != 1:
        raise ValueError("Unsupported candidate capture")
    as_of = datetime.fromisoformat(captured["captured_at"]).astimezone(SHANGHAI).date().isoformat()
    if len(captured["panel"]) != 30 or set(captured["sources"]) != PROFILES.keys():
        raise ValueError("Expected the fixed 30-share panel and both source adapters")
    results = []
    for code, info in captured["panel"].items():
        candidates = [captured["sources"][source][code] for source in PROFILES]
        results.append({**info, **identify(code, candidates, as_of)})
    per_source = {}
    for source in PROFILES:
        candidates = [item for result in results for item in result["candidates"] if item["source"] == source]
        per_source[source] = {
            "http_200": sum(item.get("http_status") == 200 for item in candidates),
            "with_formula": sum(bool(item["formula"]) for item in candidates),
            "parsed": sum(bool(item["parsed"] and item["parsed"]["status"] == "parsed") for item in candidates),
            "statuses": dict(Counter(item["status"] for item in candidates)),
        }
    cohorts = sorted({result["group"] for result in results})
    return {
        "schema_version": 1, "captured_at": captured["captured_at"], "as_of": as_of,
        "totals": summarize(results), "sources": per_source,
        "cohorts": {group: summarize([row for row in results if row["group"] == group]) for group in cohorts},
        "funds": results,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit(json.loads(args.capture.read_text(encoding="utf-8")))
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in ("as_of", "sources", "totals")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
