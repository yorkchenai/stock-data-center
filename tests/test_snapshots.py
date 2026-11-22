"""Verify the public JSON contract and mirror without live network access."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

import exchange_calendars as xcals
import pandas as pd

from stock_analysis import data, snapshots
from stock_analysis.indicators import calculate_indicators
from stock_analysis.web import INDICATOR_FIELDS, ROOT


NOW = datetime(2026, 11, 22, 10, tzinfo=timezone.utc)
CONFIG = json.loads(snapshots.CONFIG.read_text(encoding="utf-8"))


def grant(provider="tencent", **overrides):
    return {
        "symbol": "sh688981", "provider": provider, "channels": ["pages", "github_raw_with_history"],
        "scope": "daily_ohlcv_and_indicators_v1", "evidence": "test-only synthetic grant",
        "valid_from": "2026-01-01", "valid_through": "2026-11-22",
    } | overrides


def fixture():
    # Artificial prices on actual session dates, omitting the cited suspension.
    dates = xcals.get_calendar("XSHG").sessions_in_range("2025-01-02", "2026-11-20")
    dates = dates[~dates.to_series().between("2025-09-01", "2025-09-08").to_numpy()]
    close = [100 + (i % 13) / 2 for i in range(len(dates))]
    return pd.DataFrame({"date": dates, "open": close, "close": close,
                         "high": [c + 1 for c in close], "low": [c - 1 for c in close],
                         "volume_lots": [1000 + i for i in range(len(dates))], "turnover_cny": 10000000})


def load(path):
    return json.loads(path.read_bytes(), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


class SnapshotContract(TestCase):
    def test_default_and_unapproved_sources_never_fetch_or_write_data(self):
        config = deepcopy(CONFIG)
        config["redistribution_permissions"] = [
            grant("eastmoney", channels=["pages"]), grant(valid_through="2026-11-21"),
        ]
        with TemporaryDirectory() as temporary, mock.patch.object(snapshots, "fetch_daily") as fetch:
            output = Path(temporary) / "v1"
            manifest = snapshots.build_snapshots(output, config, NOW, public=True)
            fetch.assert_not_called()
            self.assertEqual(manifest["status"], "publication_blocked")
            self.assertEqual(load(output / "manifest.json"), manifest)
            self.assertEqual(len(list(output.rglob("*.json"))), 9)
            for item in manifest["instruments"]:
                for key in ("latest", "history"):
                    result = load(output / item[key])
                    self.assertEqual(result["schema_version"], 1)
                    self.assertEqual(result["symbol"], item["symbol"])
                    self.assertEqual(result["status"], "publication_blocked")
                    self.assertEqual(result["rows"], [])
                    self.assertIsNone(result["as_of_utc"])
                    self.assertIsNone(result["last_trade_date"])
            config["redistribution_permissions"] = [grant()]
            snapshots.build_snapshots(Path(temporary) / "pr", config, NOW, public=True, metadata_only=True)
            fetch.assert_not_called()

    def test_history_and_last_60_use_same_calculation_and_preserve_halt(self):
        config = deepcopy(CONFIG)
        config["redistribution_permissions"] = [grant()]
        frame = fixture()
        with (TemporaryDirectory() as temporary,
              mock.patch.object(data, "eastmoney") as eastmoney,
              mock.patch.object(data, "tencent", return_value=frame) as tencent):
            output = Path(temporary) / "v1"
            manifest = snapshots.build_snapshots(output, config, NOW, public=True)
            eastmoney.assert_not_called()
            tencent.assert_called_once()
            item = next(i for i in manifest["instruments"] if i["symbol"] == "sh688981")
            history = load(output / item["history"])
            latest = load(output / item["latest"])
            self.assertEqual(history["status"], "ok")
            self.assertEqual(history["source"], "tencent")
            self.assertEqual(history["calculation_start"], "2025-01-01")
            self.assertEqual(history["calculation_first_trade_date"], "2025-01-02")
            self.assertEqual(history["last_trade_date"], "2026-11-20")
            self.assertEqual(history["row_count"], 450)
            self.assertEqual(latest["row_count"], 60)
            self.assertEqual(latest["rows"], history["rows"][-60:])
            expected = json.loads(calculate_indicators(frame).to_json(orient="records", double_precision=15))
            for field in INDICATOR_FIELDS:
                self.assertEqual([row[field] for row in history["rows"]], [row[field] for row in expected])
            self.assertIsNone(history["rows"][0]["ADX14"])
            self.assertEqual(history["units"]["VOL5"], "手")
            self.assertEqual(history["units"]["turnover_cny"], "元")
            self.assertEqual(history["adjustment"], "none")
            self.assertFalse(history["stale"])
            self.assertEqual(history["fresh_until_utc"], "2026-11-22T16:00:00+00:00")
            self.assertEqual(len(history["validation"]["confirmed_suspension_sessions"]), 6)
            self.assertEqual(history["validation"]["unverified_missing_sessions"], [])
            for path, digest in item["sha256"].items():
                self.assertEqual(digest, hashlib.sha256((output / path).read_bytes()).hexdigest())

    def test_stale_and_failed_fetches_do_not_claim_current_data(self):
        frame = fixture()
        config = {"calculation_start": "2025-01-01", "instruments": {"sh688981": "中芯国际"},
                  "redistribution_permissions": [grant("eastmoney"), grant()]}
        with (TemporaryDirectory() as temporary,
              mock.patch.object(data, "eastmoney", return_value=frame.iloc[:-1]),
              mock.patch.object(data, "tencent", return_value=frame.iloc[:-2]) as tencent):
            directory = Path(temporary)
            snapshots.build_snapshots(directory / "stale", config, NOW, public=True)
            result = load(directory / "stale/sh688981/latest.json")
            self.assertEqual(result["status"], "stale")
            self.assertTrue(result["stale"])
            self.assertEqual(result["last_trade_date"], "2026-11-19")
            self.assertEqual(result["source"], "eastmoney")
            tencent.side_effect = OSError("provider unavailable")
            with mock.patch.object(data, "eastmoney", side_effect=OSError("provider unavailable")):
                snapshots.build_snapshots(directory / "failed", config, NOW, public=True)
            result = load(directory / "failed/sh688981/latest.json")
            self.assertEqual(result["status"], "unavailable")
            self.assertEqual(result["rows"], [])
            self.assertIsNone(result["last_trade_date"])
            self.assertEqual(len(result["attempts"]), 2)

    def test_session_cutoff_and_weekend(self):
        friday_morning = datetime(2026, 11, 20, 2, tzinfo=timezone.utc)
        friday_after_cutoff = datetime(2026, 11, 20, 9, 10, tzinfo=timezone.utc)
        expected = "2026-11-20", datetime(2026, 11, 23, 9, tzinfo=timezone.utc)
        self.assertEqual(snapshots.market_window(friday_morning)[0], "2026-11-19")
        self.assertEqual(snapshots.market_window(friday_after_cutoff), expected)
        self.assertEqual(snapshots.market_window(NOW), expected)

    def test_calendar_audit_stays_within_published_year_end(self):
        calendar = xcals.get_calendar("XSHG")
        end = calendar.bound_max()
        last_session = calendar.sessions[calendar.sessions <= end][-1]
        frame = fixture().iloc[-1:].assign(date=last_session)
        audit = snapshots.audit_calendar(frame, snapshots.resolve_symbol("sz399006"),
                                         last_session.date().isoformat(), end.date().isoformat())
        self.assertTrue(audit["completeness_verified"])
        with self.assertRaisesRegex(ValueError, "calendar coverage"):
            snapshots.audit_calendar(frame, snapshots.resolve_symbol("sz399006"),
                                     last_session.date().isoformat(), f"{end.year + 1}-01-01")


class SnapshotMirror(TestCase):
    def test_mirror_creates_and_updates_only_data_branch_and_rejects_corruption(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            remote = root / "remote.git"
            checkout = root / "checkout"
            checkout.mkdir()

            def command(*args, check=True, **kwargs):
                return subprocess.run(args, cwd=checkout, text=True, capture_output=True, check=check, **kwargs)

            command("git", "init", "--bare", str(remote))
            command("git", "init", "-b", "main")
            (checkout / "README").write_text("original website")
            command("git", "add", "README")
            command("git", "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "website")
            command("git", "remote", "add", "origin", str(remote))
            command("git", "push", "origin", "main")
            sha = command("git", "rev-parse", "HEAD").stdout.strip()
            env = os.environ | {"GITHUB_SHA": sha}
            script = ROOT / "scripts/mirror_pages_snapshots.sh"
            first, second = root / "first", root / "second"
            with mock.patch.dict(os.environ, {"GITHUB_SHA": sha}):
                snapshots.build_snapshots(first, CONFIG, NOW, public=True)
                snapshots.build_snapshots(second, CONFIG, NOW.replace(minute=10), public=True)
            command("bash", str(script), str(first), env=env)
            command("bash", str(script), str(first), env=env)
            command("bash", str(script), str(second), env=env)
            ref = "refs/heads/snapshots-v1"
            self.assertEqual(command("git", "-C", str(remote), "rev-list", "--count", ref).stdout.strip(), "2")
            self.assertEqual(command("git", "-C", str(remote), "ls-tree", "--name-only", ref).stdout.strip(), "data")
            published = command("git", "-C", str(remote), "show", f"{ref}:data/v1/manifest.json").stdout
            self.assertEqual(published, (second / "manifest.json").read_text())
            (second / "sh688981/history.json").write_text("{}")
            rejected = command("bash", str(script), str(second), env=env, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("checksum", rejected.stderr)
            self.assertEqual(command("git", "-C", str(remote), "rev-parse", "main").stdout.strip(), sha)
