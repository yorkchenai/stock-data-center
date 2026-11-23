"""Local interactive chart server and portable real-history demo export."""
from datetime import date
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit
import argparse
import json
import shutil
from threading import Lock

import pandas as pd

from .funds import CODE, load_fund, search_funds
from .fund_charts import sector_analysis, sector_history
from .indicators import calculate_indicators
from .pipeline import ANALYSIS_LAYERS, run_analysis
from .symbols import resolve_symbol
from .validation import NUMERIC_COLUMNS, normalize_daily

ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = ROOT / "web"
INDICATOR_FIELDS = [
    "change_pct", "MA5", "MA10", "MA20", "MA60", "VOL5", "VOL10",
    "EMA12", "EMA26", "DIF", "DEA", "MACD_hist", "RSI6", "RSI12", "RSI14", "RSI24",
    "ADX14", "+DI", "-DI",
]


def chart_payload(frame, report, live_analysis=True):
    """Serialize existing daily values without rescaling or recalculating them."""
    daily = normalize_daily(frame)
    missing = set(INDICATOR_FIELDS) - set(frame.columns)
    if missing:
        raise ValueError(f"Missing precomputed indicators: {sorted(missing)}")
    frame = frame.copy()
    frame["date"] = pd.to_datetime(frame.date).dt.strftime("%Y-%m-%d")
    frame = frame.sort_values("date").reset_index(drop=True)
    frame[NUMERIC_COLUMNS] = daily[NUMERIC_COLUMNS]
    values = frame[INDICATOR_FIELDS].apply(pd.to_numeric, errors="raise")
    if ((values == float("inf")) | (values == float("-inf"))).any().any():
        raise ValueError("Non-finite indicator values")
    frame[INDICATOR_FIELDS] = values
    return {
        "schema_version": 1, "instrument": report["instrument"],
        "source": report.get("provenance", {}).get("source", "saved_run"),
        "requested_start": report.get("start", frame.date.iloc[0]),
        "requested_end": report.get("end", frame.date.iloc[-1]),
        "analysis_layers": ANALYSIS_LAYERS, "supplementary_indicator": "ADX14",
        "units": {"volume_lots": "手", "VOL5": "手", "VOL10": "手", "turnover_cny": "元"},
        "validation": report.get("validation"), "live_analysis": live_analysis,
        "rows": json.loads(frame.to_json(orient="records", double_precision=15)),
    }


def load_demo(run_dir=None):
    if run_dir is not None:
        directory = Path(run_dir)
        report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
        if report.get("status") != "success":
            raise ValueError("Saved run must have status=success")
        json_path = directory / "indicators.json"
        if json_path.exists():
            frame = pd.DataFrame(json.loads(json_path.read_text(encoding="utf-8")))
        else:
            frame = pd.read_csv(directory / "indicators.csv")
        return chart_payload(frame, report)
    # First-stage historical CSV is the offline source. All formulas remain in indicators.py.
    frame = calculate_indicators(pd.read_csv(ROOT / "results/000688_daily.csv"))
    return chart_payload(frame, {
        "instrument": {"code": "000688", "market": "sh", "kind": "index"},
        "provenance": {"source": "repository_csv"},
    })


def export_demo(destination, dataset):
    destination = Path(destination).resolve()
    if destination == WEB_ROOT.resolve() or WEB_ROOT.resolve() in destination.parents:
        raise ValueError("Export into a separate directory")
    # Avoid overwriting an existing user directory or a prior exported demo.
    destination.mkdir(parents=True, exist_ok=False)
    shutil.copytree(WEB_ROOT, destination, dirs_exist_ok=True)
    payload = dict(dataset, live_analysis=False)
    (destination / "api").mkdir()
    (destination / "api/demo").write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    return destination


class ChartHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, dataset, output_root, analysis_lock, **kwargs):
        self.dataset = dataset
        self.output_root = output_root
        self.analysis_lock = analysis_lock
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def send_json(self, status, payload):
        content = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        if self.path == "/api/demo":
            self.send_json(200, self.dataset)
        elif self.path.startswith("/api/funds/"):
            self.do_get_fund()
        elif self.path.startswith("/api/"):
            self.send_json(404, {"error": "Unknown API route"})
        else:
            super().do_GET()

    def do_get_fund(self):
        request = urlsplit(self.path)
        action = request.path.removeprefix("/api/funds/")
        if action == "status":
            self.send_json(200, {"local": True})
            return
        try:
            if action == "search":
                term = parse_qs(request.query).get("q", [""])[0]
                payload = {"funds": search_funds(term)}
            elif not request.query and len(parts := action.split("/")) in (2, 3) and CODE.fullmatch(parts[0]) and parts[1] == "sectors":
                payload = sector_analysis(parts[0]) if len(parts) == 2 else sector_history(parts[0], parts[2])
            elif CODE.fullmatch(action) and not request.query:
                payload = load_fund(action)
            else:
                self.send_json(400, {"error": "请提供基金名称或六位场外基金代码。"})
                return
        except (URLError, TimeoutError):
            self.send_json(502, {"error": "基金来源暂不可访问。可导入已获准使用的净值 JSON。"})
            return
        except (ValueError, OverflowError) as exc:
            self.send_json(422, {"error": str(exc)})
            return
        self.send_json(200, payload)

    def do_POST(self):
        if self.path != "/api/analyze":
            self.send_json(404, {"error": "Unknown API route"})
            return
        try:
            if self.headers.get_content_type() != "application/json":
                raise ValueError("Expected application/json")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                raise ValueError("Request body must contain 1–16384 bytes")
            options = json.loads(self.rfile.read(length))
            if not isinstance(options, dict) or set(options) != {"symbol", "kind", "start", "end"}:
                raise ValueError("Provide symbol, kind, start and end")
            if not all(isinstance(value, str) for value in options.values()):
                raise ValueError("All parameters must be strings")
            instrument = resolve_symbol(options["symbol"], options["kind"])
            start = date.fromisoformat(options["start"]).isoformat()
            end = date.fromisoformat(options["end"]).isoformat()
            if start > end:
                raise ValueError("Start date must not follow end date")
        except (ValueError, TypeError) as exc:
            self.send_json(400, {"error": str(exc)})
            return
        try:
            # The existing PNG renderer uses pyplot. Serialize those pipeline calls.
            with self.analysis_lock:
                frame, report = run_analysis(instrument, start, end, output_root=self.output_root)
            self.send_json(200, chart_payload(frame, report))
        except Exception as exc:
            self.send_json(502, {"error": str(exc)})


def make_server(host="127.0.0.1", port=8765, run_dir=None, output_root=Path("results")):
    dataset = load_demo(run_dir)
    handler = partial(ChartHandler, dataset=dataset, output_root=output_root, analysis_lock=Lock())
    return ThreadingHTTPServer((host, port), handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Interactive A-share daily technical charts")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--run-dir", type=Path, help="Read precomputed JSON/CSV and report from an existing successful run")
    parser.add_argument("--output-root", type=Path, default=Path("results"))
    parser.add_argument("--export-demo", type=Path, help="Export an offline static demo into a new directory")
    args = parser.parse_args(argv)
    if args.export_demo:
        destination = export_demo(args.export_demo, load_demo(args.run_dir))
        print(f"Demo exported to {destination}\nRun: python -m http.server 8765 --bind 127.0.0.1 --directory {destination}")
        return
    server = make_server(args.host, args.port, args.run_dir, args.output_root)
    print(f"Interactive charts: http://{args.host}:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
