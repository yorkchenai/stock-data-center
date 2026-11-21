"""Portable, atomic ZIP bundles and independent per-run records."""
from base64 import b64encode
from datetime import datetime, timezone
from hashlib import sha256
from html import escape
from pathlib import Path
import json
import os
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile


def write_json(path, value):
    """Replace one JSON file atomically, safe for readers during concurrent runs."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def save_run(report, out, output_root):
    """Save diagnostics for failed analyses too. ZIPs publish only when complete."""
    archive = out.parent / (report["run_id"] + ".zip")
    record_path = Path(output_root) / "run-records" / (report["run_id"] + ".json")
    report["finished_at_utc"] = datetime.now(timezone.utc).isoformat()
    report["artifacts"] = {
        "archive": str(archive.resolve()), "checksum": str(archive.resolve()) + ".sha256",
        "preview": "preview.html", "manifest": "manifest.json",
        "record": str(record_path.resolve()),
        "storage": "local; copy or upload to retain beyond this execution environment",
    }
    record = {
        key: report.get(key) for key in [
            "run_id", "schema_version", "instrument", "requested_source", "start", "end",
            "started_at_utc", "finished_at_utc", "status", "rows", "output_dir", "artifacts", "error",
            "github_run_url",
        ]
    }
    record["data_source"] = report.get("provenance", {}).get("source")
    record["attempts"] = report.get("provenance", {}).get("attempts", report.get("attempts", []))
    write_json(out / "report.json", report)
    write_json(out / "record.json", record)
    write_json(record_path, record)

    temporary = None
    try:
        details = escape(json.dumps(report, ensure_ascii=False, indent=2))
        images = []
        for path in sorted((out / "charts").glob("*.png")):
            encoded = b64encode(path.read_bytes()).decode("ascii")
            images.append(f'<figure><figcaption>{escape(path.name)}</figcaption><img alt="{escape(path.name)}" src="data:image/png;base64,{encoded}"></figure>')
        links = " ".join(
            f'<a href="{name}">{name}</a>' for name in ["daily.csv", "indicators.csv", "indicators.json", "report.json", "record.json"]
            if (out / name).is_file()
        )
        html = (
            '<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<title>技术分析运行结果</title><style>body{font-family:system-ui;margin:24px;max-width:1400px}'
            'img{width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{margin-right:12px}</style>'
            f'<h1>{escape(report["run_id"])}</h1><p>{escape(report["status"])}</p>'
            f'<nav>{links}</nav>{"".join(images)}<details><summary>运行记录与校验结果</summary><pre>{details}</pre></details></html>'
        )
        (out / "preview.html").write_text(html, encoding="utf-8")
        files = sorted(path for path in out.rglob("*") if path.is_file() and path.name != "manifest.json")
        manifest = {
            "schema_version": 1, "run_id": report["run_id"], "status": report["status"],
            "files": [{"path": path.relative_to(out).as_posix(), "bytes": path.stat().st_size,
                       "sha256": sha256(path.read_bytes()).hexdigest()} for path in files],
        }
        write_json(out / "manifest.json", manifest)
        with tempfile.NamedTemporaryFile(dir=out.parent, suffix=".zip.tmp", delete=False) as handle:
            temporary = Path(handle.name)
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED) as bundle:
            for path in files + [out / "manifest.json"]:
                bundle.write(path, arcname=path.relative_to(out).as_posix())
        digest = sha256(temporary.read_bytes()).hexdigest()
        os.replace(temporary, archive)
        archive.with_name(archive.name + ".sha256").write_text(f"{digest}  {archive.name}\n", encoding="ascii")
    except Exception as exc:
        archive.unlink(missing_ok=True)
        archive.with_name(archive.name + ".sha256").unlink(missing_ok=True)
        (out / "manifest.json").unlink(missing_ok=True)
        (out / "preview.html").unlink(missing_ok=True)
        report.update(status="failed", artifact_error=f"{type(exc).__name__}: {exc}")
        record.update(status="failed", artifact_error=report["artifact_error"])
        write_json(out / "report.json", report)
        write_json(out / "record.json", record)
        write_json(record_path, record)
        raise
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
