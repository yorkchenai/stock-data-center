"""Run preservation, bundle integrity and evidence-scoped gap classification."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock
from zipfile import ZipFile
import json

import pandas as pd

from stock_analysis.artifacts import save_run, write_json
from stock_analysis.data import FetchError
from stock_analysis.pipeline import run_analysis
from stock_analysis.symbols import resolve_symbol
from stock_analysis.validation import audit_calendar, normalize_daily

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "results/000688_daily.csv"


class SuspensionTests(TestCase):
    def setUp(self):
        # Existing real index dates are used only as the session-date fixture.
        frame = normalize_daily(pd.read_csv(BASELINE))
        self.dates = frame[frame.date.between("2025-08-28", "2025-09-10")].copy()
        self.missing = ["2025-09-01", "2025-09-02", "2025-09-03", "2025-09-04", "2025-09-05", "2025-09-08"]
        self.with_gap = self.dates[~self.dates.date.dt.strftime("%Y-%m-%d").isin(self.missing)].copy()

    def test_confirmed_suspension_matches_six_sessions(self):
        before = self.with_gap.copy(deep=True)
        report = audit_calendar(self.with_gap, resolve_symbol("688981"), "2025-08-28", "2025-09-10")
        self.assertEqual(report["missing_sessions"], self.missing)
        self.assertEqual(report["confirmed_suspension_sessions"], self.missing)
        self.assertEqual(report["unverified_missing_sessions"], [])
        self.assertTrue(report["active_session_dates_match"])
        self.assertFalse(report["completeness_verified"])
        self.assertEqual(report["suspension_evidence"][0]["resumption_date"], "2025-09-09")
        self.assertEqual(len(report["suspension_evidence"][0]["sources"]), 2)
        pd.testing.assert_frame_equal(self.with_gap, before)

    def test_unrelated_symbol_and_extra_gap_stay_unverified(self):
        other = audit_calendar(self.with_gap, resolve_symbol("600519"), "2025-08-28", "2025-09-10")
        self.assertEqual(other["confirmed_suspension_sessions"], [])
        self.assertEqual(other["unverified_missing_sessions"], self.missing)
        extra = self.with_gap[self.with_gap.date != "2025-09-09"]
        report = audit_calendar(extra, resolve_symbol("688981"), "2025-08-28", "2025-09-10")
        self.assertEqual(report["unverified_missing_sessions"], ["2025-09-09"])
        self.assertFalse(report["active_session_dates_match"])

    def test_partial_period_and_suspension_data_conflict(self):
        subset = self.with_gap[self.with_gap.date.between("2025-09-03", "2025-09-10")]
        report = audit_calendar(subset, resolve_symbol("688981"), "2025-09-03", "2025-09-10")
        self.assertEqual(report["confirmed_suspension_sessions"], self.missing[2:])
        conflict = audit_calendar(self.dates, resolve_symbol("688981"), "2025-08-28", "2025-09-10")
        self.assertEqual(conflict["suspension_data_conflicts"], self.missing)
        self.assertFalse(conflict["active_session_dates_match"])


class ArtifactTests(TestCase):
    def test_bundle_checksums_record_and_portable_preview(self):
        with TemporaryDirectory() as directory:
            _, report = run_analysis(resolve_symbol("000688"), "2026-01-01", "2026-11-20", directory, BASELINE)
            archive = Path(report["artifacts"]["archive"])
            checksum = Path(report["artifacts"]["checksum"]).read_text().split()[0]
            self.assertEqual(sha256(archive.read_bytes()).hexdigest(), checksum)
            record = json.loads(Path(report["artifacts"]["record"]).read_text())
            self.assertEqual(record["status"], "success")
            self.assertEqual(record["data_source"], "local_csv")
            self.assertEqual(record["instrument"]["code"], "000688")
            self.assertEqual(record["start"], "2026-01-01")
            self.assertEqual(record["end"], "2026-11-20")
            with ZipFile(archive) as bundle:
                self.assertIsNone(bundle.testzip())
                manifest = json.loads(bundle.read("manifest.json"))
                for item in manifest["files"]:
                    content = bundle.read(item["path"])
                    self.assertEqual(item["sha256"], sha256(content).hexdigest())
                    self.assertEqual(item["bytes"], len(content))
                self.assertIn("daily.csv", bundle.namelist())
                self.assertIn("indicators.json", bundle.namelist())
                self.assertEqual(len([name for name in bundle.namelist() if name.endswith(".png")]), 5)
                preview = bundle.read("preview.html").decode()
                self.assertEqual(preview.count("data:image/png;base64,"), 5)
                self.assertNotIn("<script", preview)
                self.assertNotIn("/workspace/", preview.split("<details>")[0])
                self.assertEqual(json.loads(bundle.read("report.json"))["run_id"], report["run_id"])

    def test_failed_fetch_still_has_diagnostic_archive(self):
        with TemporaryDirectory() as directory:
            with mock.patch("stock_analysis.pipeline.fetch_daily", side_effect=FetchError([{"source": "tencent", "status": "failed", "error": "network"}])):
                with self.assertRaises(FetchError):
                    run_analysis(resolve_symbol("600519"), "2025-01-01", "2025-01-10", directory)
            record = json.loads(next((Path(directory) / "run-records").glob("*.json")).read_text())
            self.assertEqual(record["status"], "failed")
            self.assertEqual(record["attempts"][0]["source"], "tencent")
            with ZipFile(record["artifacts"]["archive"]) as bundle:
                self.assertIn("report.json", bundle.namelist())
                self.assertNotIn("daily.csv", bundle.namelist())
                self.assertEqual(json.loads(bundle.read("manifest.json"))["status"], "failed")

    def test_packaging_failure_retains_failure_record_without_partial_zip(self):
        with TemporaryDirectory() as directory:
            out = Path(directory) / "stock" / "run1"
            out.mkdir(parents=True)
            report = {"run_id": "stock_run1", "status": "success", "schema_version": 1}
            with mock.patch("stock_analysis.artifacts.ZipFile", side_effect=OSError("disk full")):
                with self.assertRaisesRegex(OSError, "disk full"):
                    save_run(report, out, directory)
            record = json.loads((Path(directory) / "run-records/stock_run1.json").read_text())
            self.assertEqual(record["status"], "failed")
            self.assertIn("disk full", record["artifact_error"])
            self.assertFalse(list(Path(directory).rglob("*.zip")))
            self.assertFalse(list(Path(directory).rglob("*.tmp")))
            self.assertFalse((out / "manifest.json").exists())

    def test_concurrent_records_and_json_write_recovery(self):
        with TemporaryDirectory() as directory:
            def persist(index):
                out = Path(directory) / "stock" / f"run{index}"
                out.mkdir(parents=True)
                save_run({"run_id": f"stock_run{index}", "status": "success"}, out, directory)
            with ThreadPoolExecutor(max_workers=3) as pool:
                list(pool.map(persist, range(6)))
            self.assertEqual(len(list((Path(directory) / "run-records").glob("*.json"))), 6)
            self.assertEqual(len(list(Path(directory).rglob("*.zip"))), 6)
            path = Path(directory) / "existing.json"
            write_json(path, {"status": "previous"})
            with self.assertRaises(ValueError):
                write_json(path, {"status": float("nan")})
            self.assertEqual(json.loads(path.read_text()), {"status": "previous"})
