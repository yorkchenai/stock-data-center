"""Versioned end-of-day JSON for Pages and its GitHub Raw mirror."""
import argparse
from datetime import date, datetime, time, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
from zoneinfo import ZoneInfo

import exchange_calendars as xcals
import pandas as pd

from .data import FetchError, fetch_daily
from .indicators import calculate_indicators
from .symbols import resolve_symbol
from .validation import audit_calendar
from .web import ROOT, chart_payload

CONFIG = ROOT / "config/snapshots.json"
SHANGHAI = ZoneInfo("Asia/Shanghai")
PROVIDERS = ("eastmoney", "tencent")
PUBLIC_CHANNELS = {"pages", "github_raw_with_history"}
DAILY_CUTOFF = time(17)
LATEST_ROWS = 60


def market_window(now):
    """Return the expected daily record and when that expectation next changes."""
    local = now.astimezone(SHANGHAI)
    today = local.date()
    calendar = xcals.get_calendar("XSHG")
    last_known = calendar.bound_max().date()
    cutoff = today if local.time() >= DAILY_CUTOFF else today - timedelta(days=1)
    if today > last_known or pd.Timestamp(cutoff) < calendar.first_session:
        raise ValueError("trading_calendar_out_of_range")
    sessions = calendar.sessions
    current = sessions[sessions <= pd.Timestamp(cutoff)][-1].date()
    upcoming = sessions[sessions > pd.Timestamp(cutoff)]
    if len(upcoming):
        expiry = datetime.combine(upcoming[0].date(), DAILY_CUTOFF, SHANGHAI)
    else:
        expiry = datetime.combine(last_known + timedelta(days=1), time(), SHANGHAI)
    return current.isoformat(), expiry.astimezone(timezone.utc)


def public_permissions(config, symbol, now):
    """Only v1 grants covering OHLCV, indicators and both public channels qualify."""
    result = {}
    day = now.astimezone(SHANGHAI).date()
    for grant in config["redistribution_permissions"]:
        if (grant["symbol"] != symbol or grant["provider"] not in PROVIDERS
                or not PUBLIC_CHANNELS <= set(grant["channels"])
                or grant["scope"] != "daily_ohlcv_and_indicators_v1"
                or not grant["evidence"].strip()):
            continue
        start = date.fromisoformat(grant["valid_from"])
        end = date.fromisoformat(grant["valid_through"])
        if start <= day <= end:
            result[grant["provider"]] = min(end, result.get(grant["provider"], end))
    return result


def fetch_snapshot(instrument, name, start, end, providers, now, expires):
    def validate(frame):
        result = audit_calendar(frame, instrument, start, end)
        if result["suspension_data_conflicts"] or (
                instrument.kind == "index" and result["interior_missing_sessions"]):
            raise ValueError("trading_calendar_conflict")
        return result

    dataset = None
    attempted = []
    for provider in PROVIDERS:
        if provider not in providers:
            continue
        try:
            frame, provenance = fetch_daily(instrument, start, end, source=provider, validator=validate)
        except FetchError:
            attempted.append({"source": provider, "status": "fetch_failed"})
            continue
        fetched_at = datetime.now(timezone.utc).isoformat()
        audit = validate(frame)
        last_date = frame.date.iloc[-1].date().isoformat()
        stale = last_date < end
        status = "stale" if stale else "partial" if audit["unverified_missing_sessions"] else "ok"
        attempted.append({"source": provider, "status": status})
        if dataset is not None and dataset["last_trade_date"] >= last_date and stale:
            continue
        payload = chart_payload(calculate_indicators(frame), {
            "instrument": {"code": instrument.code, "market": instrument.market, "kind": instrument.kind},
            "provenance": provenance, "start": start, "end": end, "validation": audit,
        }, live_analysis=False)
        # The calendar/entitlement may expire even if no new Actions run executes.
        deadline = (datetime.combine(providers[provider] + timedelta(days=1), time(), SHANGHAI)
                    if providers[provider] else expires)
        dataset = payload | {
            "status": status, "last_trade_date": last_date, "stale": stale,
            "as_of_utc": fetched_at,
            "fresh_until_utc": min(expires, deadline).astimezone(timezone.utc).isoformat(),
        }
        if not stale:
            break

    base = {
        "schema_version": 1, "symbol": instrument.symbol, "instrument_name": name,
        "instrument_name_source": "mvp_catalog", "status": "unavailable", "source": None,
        "instrument": {"code": instrument.code, "market": instrument.market, "kind": instrument.kind},
        "generated_at_utc": now.isoformat(), "as_of_utc": None, "last_trade_date": None,
        "expected_session": end, "calculation_start": start, "calculation_first_trade_date": None,
        "adjustment": "none", "fresh_until_utc": None, "stale": None, "validation": None,
        "units": {"price": "点" if instrument.kind == "index" else "元",
                  "volume_lots": "手", "VOL5": "手", "VOL10": "手", "turnover_cny": "元"},
        "attempts": attempted, "rows": [],
    }
    if dataset is None:
        base["status"] = "unavailable" if providers else "publication_blocked"
        return base
    dataset["units"].update(base["units"])
    return base | dataset | {"calculation_first_trade_date": dataset["rows"][0]["date"]}


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode()
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def build_snapshots(destination, config, now, *, public, metadata_only=False):
    if not public and destination is not None:
        raise ValueError("Live validation may only produce a rows-free report")
    if destination is not None:
        destination.mkdir(parents=True, exist_ok=False)
    try:
        end, expires = market_window(now)
    except ValueError:
        end, expires = None, None
    items = []
    for symbol, name in config["instruments"].items():
        instrument = resolve_symbol(symbol)
        if instrument.symbol != symbol:
            raise ValueError("Expected a market-prefixed canonical symbol")
        approved = {} if metadata_only else (
            public_permissions(config, symbol, now) if public else dict.fromkeys(PROVIDERS)
        )
        start = config["calculation_start"]
        # A calendar failure must not fetch or declare a fresh snapshot.
        payload = fetch_snapshot(instrument, name, start, end, approved if end else {}, now, expires)
        if end is None:
            payload["status"] = "unavailable"
            payload["error"] = "trading_calendar_out_of_range"
        rows = payload.pop("rows")
        latest, history = f"{symbol}/latest.json", f"{symbol}/history.json"
        payload["history"] = "history.json"
        payload["calculated_row_count"] = len(rows)
        hashes = {}
        if destination is not None:
            for path, window, kind in ((latest, rows[-LATEST_ROWS:], "latest"), (history, rows, "history")):
                hashes[path] = write_json(destination / path, payload | {
                    "kind": kind, "row_count": len(window), "rows": window,
                })
        items.append({
            **{key: payload[key] for key in ("symbol", "status", "instrument_name", "source", "generated_at_utc",
               "as_of_utc", "last_trade_date", "expected_session", "fresh_until_utc", "stale", "units",
               "adjustment", "calculation_start", "calculated_row_count", "validation", "attempts")},
            "latest": latest, "history": history, "sha256": hashes,
        })
    status = "ok" if all(item["status"] == "ok" for item in items) else "partial"
    if all(item["status"] == "publication_blocked" for item in items):
        status = "publication_blocked"
    if all(item["status"] == "unavailable" for item in items):
        status = "unavailable"
    manifest = {
        "schema_version": 1, "symbol": None, "kind": "manifest", "status": status,
        "generated_at_utc": now.isoformat(), "commit_sha": os.getenv("GITHUB_SHA"),
        "mode": "public_snapshot" if public else "local_live_validation",
        "calculation_start": config["calculation_start"], "expected_session": end,
        "instruments": items,
    }
    if destination is not None:
        write_json(destination / "manifest.json", manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path, help="Write policy-filtered JSON into a new directory")
    mode.add_argument("--validate-live", action="store_true", help="Print a rows-free data validation report")
    parser.add_argument("--metadata-only", action="store_true", help="Build row-free files for PR checks")
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    if args.metadata_only and args.validate_live:
        parser.error("--metadata-only requires --output")
    manifest = build_snapshots(args.output, config, datetime.now(timezone.utc),
                               public=not args.validate_live, metadata_only=args.metadata_only)
    print(json.dumps(manifest, ensure_ascii=False, allow_nan=False, indent=2))
    if args.validate_live and any(item["status"] == "unavailable" for item in manifest["instruments"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
