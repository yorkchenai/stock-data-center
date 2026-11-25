"""Keep public portfolio snapshots and dated security classifications separate."""
from datetime import date, timedelta
from urllib.parse import urlsplit


def iso_day(value):
    if date.fromisoformat(value).isoformat()!=value:
        raise ValueError("Expected a canonical ISO date")
    return value


def official_source(value):
    url = urlsplit(value or "")
    if url.scheme!="https" or not url.hostname or url.username or url.password:
        raise ValueError("Disclosure evidence requires a public HTTPS source")
    return value


def eligible_holdings(code, reports, as_of):
    confirmed = []
    for report in reports:
        if code not in report["share_codes"]:
            continue
        period = iso_day(report["period_end"])
        disclosure = iso_day(report["disclosed_on"])
        if period>disclosure:
            raise ValueError("Disclosure predates the portfolio measurement")
        official_source(report["source"])
        # Dates with no publication time are usable from the next calendar day.
        if (date.fromisoformat(disclosure)+timedelta(days=1)).isoformat()<=as_of:
            confirmed.append(report)
    return max(confirmed,key=lambda item:(item["period_end"],item["disclosed_on"]),default=None)


def holdings_evidence(code, reports, classifications, catalog, as_of):
    report = eligible_holdings(code,reports,as_of)
    if not report:
        return {"status":"unverified", "sector_support":{}}
    totals = {}
    positions = []
    top = report.get("top",[])
    if (len({row["symbol"] for row in top}) != len(top)
            or sum(row["weight_pct_nav"] for row in top)>100):
        raise ValueError("Portfolio positions must be distinct and remain in original NAV weights")
    for row in top:
        weight = row["weight_pct_nav"]
        if not 0 < weight <= 100:
            raise ValueError("Position weight is a percentage of fund net assets")
        dated = [mapping for mapping in classifications.get(row["symbol"],[])
                 if iso_day(mapping["effective_from"]) <= report["period_end"]
                 and (not mapping.get("effective_to") or report["period_end"] <= iso_day(mapping["effective_to"]))
                 and iso_day(mapping["published_on"]) < as_of]
        if len(dated)>1:
            raise ValueError("Overlapping verified security classifications")
        if not dated:
            continue
        verified = dated[0]
        official_source(verified["source"])
        positions.append(row["symbol"])
        for target in verified["indices"]:
            if target not in catalog or catalog[target]["role"]=="market":
                raise ValueError("Unrecognized industry or theme code in evidence")
            evidence = totals.setdefault(target,{"known_weight_pct_nav":0,"positions":[],
                                                 "scope":"verified_disclosed_positions",
                                                 "disclosed_on":report["disclosed_on"],"source":report["source"]})
            evidence["positions"].append({"symbol":row["symbol"],"source":verified["source"]})
            evidence["known_weight_pct_nav"] += weight
    for item in totals.values():
        item["supportible"] = item["known_weight_pct_nav"]>=5
    return {"status":"matched_top_positions" if positions else "no_classified_positions",
            "period_end":report["period_end"],"disclosed_on":report["disclosed_on"],
            "source":report["source"], "evidence_level":report.get("evidence_level"),"stock_weight_pct_total_assets":report.get("stock_weight_pct_total_assets"),
            "official_industries":report.get("industries",[]),"official_top_positions":len(report.get("top",[])),
            "mapped_positions":len(set(positions)),"sector_support":totals}


def known_tracking(fund,catalog):
    if fund["category"]!="index":
        return []
    return [{"code":item["code"],"name":catalog[item["code"]]["name"],
             "source":official_source(item["source_url"]),"kind":"official_tracking"}
            for item in fund.get("related",[])
            if item.get("kind")=="official_tracking" and item.get("code") in catalog and item.get("source_url")]
