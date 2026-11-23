"""Compare candidate profiles and compile reviewed fund benchmark regimes."""
import argparse
from datetime import date, datetime, timedelta
from functools import lru_cache
import json
from pathlib import Path
from urllib.parse import urlsplit

from .fund_benchmark_formula import formula_key, parse_formula
from .fund_benchmark_sources import PROFILES, candidate_record, read_candidate
from .funds import CODE, SHANGHAI

REVIEWED = Path(__file__).with_name("fund_benchmark_disclosures.json")
SUPPORTED_METHODS = {"single_index", "daily_weighted", "period_weighted"}
ENGINE_BASES = {"price", "total_return", "full_price", "net_price"}


def https_source(value):
    url = urlsplit(value or "")
    if url.scheme != "https" or not url.hostname or url.username or url.password:
        raise ValueError("An HTTPS evidence URL is required")
    return value


def iso_day(value):
    if not isinstance(value,str) or date.fromisoformat(value).isoformat()!=value:
        raise ValueError("Expected a calendar day in YYYY-MM-DD format")
    return value


@lru_cache(maxsize=1)
def reviewed_disclosures():
    payload = json.loads(REVIEWED.read_text(encoding="utf-8"))
    if payload["schema_version"] != 1:
        raise ValueError("Unsupported benchmark disclosure version")
    return payload["funds"]


def compile_components(method, parsed):
    if method not in SUPPORTED_METHODS or parsed["status"]!="parsed":
        return None
    components = []
    for item in parsed["components"]:
        mapping = item.get("mapping", {})
        if (item["type"]!="index" or mapping.get("status")!="matched"
                or mapping.get("basis") not in ENGINE_BASES or item.get("fx")
                or mapping.get("currency")!="CNY"):
            return None
        components.append({"id":mapping["id"],"name":item["name"],"weight":item["weight"],
                           "basis":mapping["basis"],"currency":mapping["currency"],
                           "source_url":mapping["source_url"]})
    if (len({item["id"] for item in components})!=len(components)
            or (method=="single_index" and len(components)!=1)
            or not components or abs(sum(item["weight"] for item in components)-1)>1e-8):
        return None
    return components


def review_regimes(code, entry):
    if not entry:
        return []
    if code not in entry["share_codes"]:
        raise ValueError("Reviewed evidence does not cover this fund share code")
    share_source = https_source(entry["share_source_url"])
    previous = ""
    regimes = []
    for record in entry["regimes"]:
        start = iso_day(record["effective_from"])
        finish = iso_day(record["effective_to"]) if record.get("effective_to") else None
        if start <= previous or (finish and finish<start):
            raise ValueError("Disclosure regimes overlap or are out of order")
        status = record["verification"]
        if status not in {"official_verified","official_none","unverified"}:
            raise ValueError("Unknown regime verification state")
        ref = https_source(record["source_url"]) if status!="unverified" else None
        announcement = record.get("announced_on")
        if announcement:
            iso_day(announcement)
        method = record.get("method")
        if method and method not in SUPPORTED_METHODS:
            raise ValueError("Unknown reviewed composition method")
        if method and status!="official_verified":
            raise ValueError("A composition method requires verified official evidence")
        if method:
            https_source(record["method_source_url"])
            if record.get("method_published_on"):
                iso_day(record["method_published_on"])
        formula = record.get("formula")
        if status=="official_none" and formula:
            raise ValueError("A no-benchmark period cannot also supply a formula")
        if status=="official_verified" and not formula:
            raise ValueError("Verified definition is missing its formula")
        parsed = parse_formula(formula) if formula else None
        components = compile_components(method, parsed) if parsed and not record.get("component_adjustments") else None
        regimes.append({**record,"source_url":ref,"share_source_url":share_source,
                        "engine_compatible":components is not None,
                        "engine_components":components,"parsed":parsed})
        previous = finish or "9999-12-31"
    return regimes


def known_regimes(regimes, as_of):
    known = []
    for index, item in enumerate(regimes):
        if item.get("announced_on") and item["announced_on"] > as_of:
            continue
        following = regimes[index + 1] if index + 1 < len(regimes) else None
        if following and (following.get("announced_on") or "") > as_of and item.get("effective_to"):
            if date.fromisoformat(following["effective_from"]) - date.fromisoformat(item["effective_to"]) == timedelta(days=1):
                item = {**item, "effective_to": None}
        if (item.get("method_published_on") or "") > as_of:
            item = {**item, "engine_compatible": False, "engine_components": None}
        known.append(item)
    return known


def effective_regime(regimes, as_of):
    return next((item for item in regimes if item["effective_from"] <= as_of
                 and (not item.get("effective_to") or as_of <= item["effective_to"])), None)


def export_engine(active, regimes, as_of):
    if not active or not active["engine_compatible"]:
        return None
    output = []
    for item in regimes:
        if item["effective_from"] > as_of or item["verification"] == "unverified":
            continue
        no_benchmark = item["verification"]=="official_none"
        if item["engine_compatible"]:
            method = item["method"]
        else:
            method = "none" if no_benchmark else "unverified"
        output.append({"effective_from":item["effective_from"], "effective_to":item.get("effective_to"),
                       "method":method,"source":item["source_url"] or "历史区间待核验",
                       "components":item["engine_components"] or []})
    return {"official":True,"name":active.get("name") or active["formula"],
            "formula":active["formula"],"source":active["source_url"],"source_url":active["source_url"],
            "regimes":output,"definition_as_of":as_of}


def candidate_comparison(candidate, active, regimes, as_of):
    key = formula_key(candidate["parsed"]) if candidate.get("parsed") else None
    if not candidate.get("formula"):
        return "not_applicable"
    if key is None:
        return "unparsed"
    if not active or not active["parsed"] or active["parsed"]["status"] != "parsed":
        return "official_unchecked"
    if key == formula_key(active["parsed"]):
        return "matches_official"
    for item in regimes:
        if item["verification"]=="official_verified" and key == formula_key(item["parsed"]):
            return "premature" if item["effective_from"]>as_of else "stale"
    return "differs_from_official"


def identify(code, candidates, as_of, evidence=None):
    if not isinstance(code,str) or not CODE.fullmatch(code):
        raise ValueError("Expected a six-digit fund share code")
    as_of = iso_day(as_of)
    entry = (reviewed_disclosures() if evidence is None else evidence).get(code)
    regimes = known_regimes(review_regimes(code,entry), as_of)
    active = effective_regime(regimes,as_of)
    output = []
    seen = set()
    for candidate in candidates:
        source = candidate["source"]
        if (candidate["fund_code"]!=code or source not in PROFILES or source in seen
                or candidate["source_url"]!=PROFILES[source].format(code)):
            raise ValueError("Candidate source and share code do not match")
        seen.add(source)
        formula = candidate.get("formula") if candidate.get("status")=="found" else None
        parsed = parse_formula(formula) if formula else None
        item = {**candidate,"formula":formula,"parsed":parsed}
        output.append({**item,"official_comparison":candidate_comparison(item,active,regimes,as_of)})
    found = [item for item in output if item.get("formula")]
    parsed_keys = [formula_key(item["parsed"]) for item in found if item["parsed"]["status"]=="parsed"]
    text_agreement = len({item["formula"] for item in found})==1 if len(found)>1 else None
    agreement = len(set(parsed_keys))==1 if len(parsed_keys)>1 else None
    engine = export_engine(active,regimes,as_of)
    if engine:
        grade = "A"
    elif not parsed_keys:
        grade = "D"
    elif agreement:
        grade = "B"
    else:
        grade = "C"
    if active:
        official_status = active["verification"]
    else:
        official_status = "historical_gap" if entry else "not_reviewed"
    return {"schema_version":1,"fund_code":code,"as_of":as_of,"grade":grade,
            "candidates":output,"text_agreement":text_agreement,"formula_agreement":agreement,
            "official_status":official_status,"effective_regime":active,"regimes":regimes,
            "confirmed_change_count":sum(item.get("change_confirmed", False) for item in regimes),
            "effective_change_count":sum(item.get("change_confirmed", False) and item["effective_from"] <= as_of
                                         for item in regimes),
            "engine_status":"compatible" if engine else "not_available","benchmark":engine,
            "history_points_status":"not_requested"}


def benchmark_definition(code, as_of):
    """Return only a reviewed, computable definition. This lookup performs no HTTP requests."""
    if code not in reviewed_disclosures():
        return None
    return identify(code, [], as_of)["benchmark"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("code", help="Six-digit fund share code")
    parser.add_argument("--as-of",default=datetime.now(SHANGHAI).date().isoformat())
    inputs = parser.add_mutually_exclusive_group()
    inputs.add_argument("--fetch-candidates",action="store_true",help="Read the two public HTML profiles once, if authorized")
    inputs.add_argument("--capture",type=Path,help="Use an existing candidate audit JSON")
    args = parser.parse_args()
    if args.fetch_candidates:
        candidates = [candidate_record(read_candidate(source,args.code)) for source in PROFILES]
    elif args.capture:
        saved = json.loads(args.capture.read_text(encoding="utf-8"))
        candidates = [col[args.code] for col in saved["sources"].values() if args.code in col]
    else:
        candidates = []
    print(json.dumps(identify(args.code,candidates,args.as_of),ensure_ascii=False,indent=2))


if __name__ == "__main__":
    main()
