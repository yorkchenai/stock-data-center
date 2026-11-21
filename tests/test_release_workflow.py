"""Execute the actual Release shell block with gh replaced by a local recorder."""
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import textwrap
from unittest import TestCase

ROOT = Path(__file__).resolve().parents[1]


class ReleaseWorkflowTests(TestCase):
    def run_release(self, directory):
        workflow = (ROOT / ".github/workflows/generate-indicator-charts.yml").read_text()
        step = workflow.split("      - name: Save long-term Release assets\n", 1)[1]
        script = textwrap.dedent(step.split("        run: |\n", 1)[1])
        binaries = directory / "bin"
        binaries.mkdir()
        recorder = binaries / "gh"
        recorder.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "with open(os.environ['RELEASE_CALLS'], 'a') as handle:\n"
            "    handle.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        )
        recorder.chmod(0o755)
        calls_path = directory / "calls.jsonl"
        environment = dict(os.environ, PATH=str(binaries) + os.pathsep + os.environ["PATH"],
                           RELEASE_CALLS=str(calls_path), GH_REPO="owner/repository",
                           GITHUB_RUN_ID="123", GITHUB_RUN_ATTEMPT="1", GITHUB_SHA="0" * 40,
                           GITHUB_SERVER_URL="https://github.com", GITHUB_REPOSITORY="owner/repository",
                           GITHUB_STEP_SUMMARY=str(directory / "summary.md"))
        result = subprocess.run(["bash", "-euo", "pipefail", "-c", script], cwd=directory,
                                env=environment, text=True, capture_output=True)
        calls = [json.loads(line) for line in calls_path.read_text().splitlines()] if calls_path.exists() else []
        return result, calls

    def test_ignored_assets_and_special_paths_reach_release(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            subprocess.run(["git", "init", "-q", str(directory)], check=True)
            (directory / ".gitignore").write_text("saved-analysis/\n*.zip\n*.sha256\n*.json\n")
            assets = ["saved-analysis/work/analysis/a bundle.zip",
                      "saved-analysis/work/analysis/a bundle.zip.sha256",
                      "saved-analysis/run-records/record\nwith newline.json"]
            for name in assets + ["saved-analysis/irrelevant.txt"]:
                path = directory / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture")
            ignored = subprocess.run(["git", "check-ignore", "--", assets[0]], cwd=directory, capture_output=True)
            self.assertEqual(ignored.returncode, 0)
            result, calls = self.run_release(directory)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0][:3], ["release", "create", "analysis-123-1"])
            self.assertEqual(set(calls[0][3:calls[0].index("--repo")]), set(assets))
            self.assertIn("--draft", calls[0])
            self.assertEqual(calls[1][:2], ["release", "edit"])

    def test_no_matching_files_fails_before_release_creation(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "saved-analysis").mkdir()
            (directory / "saved-analysis/irrelevant.txt").write_text("fixture")
            result, calls = self.run_release(directory)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("::error::No ZIP, SHA-256 or JSON assets found", result.stdout)
            self.assertEqual(calls, [])

    def test_missing_download_directory_fails_before_release_creation(self):
        with TemporaryDirectory() as temporary:
            result, calls = self.run_release(Path(temporary))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("saved-analysis", result.stderr)
            self.assertEqual(calls, [])
