"""Strict OHLCV normalization and independent mainland session comparison."""
from datetime import timedelta
import json
from pathlib import Path
import numpy as np
import pandas as pd

COLUMNS = ["date", "open", "close", "high", "low", "volume_lots", "turnover_cny"]
NUMERIC_COLUMNS = COLUMNS[1:]


def last_completed_session(now):
    import exchange_calendars as xcals

    today = pd.Timestamp(now).tz_convert("Asia/Shanghai").date().isoformat()
    calendar = xcals.get_calendar("XSHG")
    day = calendar.date_to_session(today, direction="previous")
    if calendar.session_close(day) > now:
        day = calendar.previous_session(day)
    return day.date().isoformat()


def frontend_calendar(now, end=None):
    """Return the audited XSHG session reference shared by Pages and the local charts."""
    import exchange_calendars as xcals

    end = end or min(now.date() + timedelta(days=31), now.date().replace(month=12, day=31)).isoformat()
    start = "2000-01-01"
    calendar = xcals.get_calendar("XSHG", start=pd.Timestamp(start) - pd.Timedelta(days=14), end=end)
    sessions = calendar.sessions[(calendar.sessions >= pd.Timestamp(start)) &
                                 (calendar.sessions <= pd.Timestamp(end))]
    return {
        "schema_version": 1, "start": start, "end": end,
        "calendar": "exchange_calendars:XSHG", "version": xcals.__version__,
        "generated_at_utc": now.isoformat(),
        "sessions": sessions.strftime("%Y-%m-%d").tolist(),
        "suspensions": json.loads(Path(__file__).with_name("suspensions.json").read_text(encoding="utf-8")),
    }


def normalize_daily(frame):
    missing = set(COLUMNS) - set(frame.columns)
    if missing:
        raise ValueError(f"Missing required fields: {sorted(missing)}")
    if frame.empty:
        raise ValueError("No historical rows returned")
    frame = frame[COLUMNS].copy()
    frame["date"] = pd.to_datetime(frame.date, errors="raise")
    if frame.date.isna().any() or (frame.date != frame.date.dt.normalize()).any():
        raise ValueError("Dates must be non-null daily dates")
    if frame.date.duplicated().any():
        raise ValueError("Duplicate trading dates")
    frame = frame.sort_values("date").reset_index(drop=True)
    frame[NUMERIC_COLUMNS] = frame[NUMERIC_COLUMNS].apply(pd.to_numeric, errors="raise")
    if not np.isfinite(frame[NUMERIC_COLUMNS].to_numpy(dtype=float)).all():
        raise ValueError("Missing or non-finite OHLCV/turnover")
    if (frame[["open", "close", "high", "low"]] <= 0).any().any():
        raise ValueError("OHLC prices must be positive")
    if ((frame.low > frame[["open", "close"]].min(axis=1)) | (frame.high < frame[["open", "close"]].max(axis=1))).any():
        raise ValueError("Inconsistent OHLC bounds")
    if (frame[["volume_lots", "turnover_cny"]] < 0).any().any():
        raise ValueError("Negative volume or turnover")
    if (frame.date.dt.weekday >= 5).any():
        raise ValueError("Weekend trading dates")
    return frame


def audit_calendar(frame, instrument, start, end):
    import exchange_calendars as xcals

    # XSHG is a mainland-session reference for SZ too, not a suspension calendar.
    calendar = xcals.get_calendar(
        "XSHG", start=pd.Timestamp(start) - pd.Timedelta(days=14),
        end=pd.Timestamp(end) + pd.Timedelta(days=14),
    )
    expected = set(calendar.sessions_in_range(start, end).strftime("%Y-%m-%d"))
    actual = set(frame.date.dt.strftime("%Y-%m-%d"))
    missing = sorted(expected - actual)
    unexpected = sorted(actual - expected)
    first, last = min(actual), max(actual)
    interior = [day for day in missing if first <= day <= last]
    evidence = json.loads(Path(__file__).with_name("suspensions.json").read_text(encoding="utf-8"))
    relevant = [item for item in evidence if item["symbol"] == instrument.symbol
                and item["kind"] == instrument.kind and item["start"] <= end and item["end"] >= start]
    suspended = {day for day in expected if any(item["start"] <= day <= item["end"] for item in relevant)}
    confirmed = sorted(set(missing) & suspended)
    unverified = sorted(set(missing) - suspended)
    suspension_conflicts = sorted(actual & suspended)
    if unexpected:
        raise ValueError(f"Non-session dates returned: {unexpected}")
    return {
        "calendar": "exchange_calendars:XSHG", "calendar_version": xcals.__version__,
        "calendar_scope": "Mainland sessions plus cited suspension exceptions; full stock listing/suspension coverage unverified",
        "expected_sessions": len(expected), "observed_sessions": len(actual),
        "missing_sessions": missing, "interior_missing_sessions": interior,
        "confirmed_suspension_sessions": confirmed,
        "unverified_missing_sessions": unverified,
        "suspension_evidence": relevant,
        "suspension_data_conflicts": suspension_conflicts,
        "expected_active_sessions": len(expected - suspended),
        "active_session_dates_match": not unverified and not suspension_conflicts,
        "unexpected_dates": unexpected, "calendar_match": not missing,
        "completeness_verified": instrument.kind == "index" and not missing,
        "note": "Only cited suspension intervals are classified as confirmed. Other gaps remain unverified. No rows are filled. Stock completeness also needs listing/suspension coverage and source verification.",
    }
