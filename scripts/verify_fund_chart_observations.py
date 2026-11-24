"""Cross-check the rendered last bar through the stock engine's selected provider."""
from argparse import ArgumentParser
from datetime import date, timedelta
import json
from pathlib import Path

from stock_analysis.data import fetch_daily
from stock_analysis.symbols import resolve_symbol


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("observations", type=Path)
    args = parser.parse_args()
    data = json.loads(args.observations.read_text(encoding="utf-8"))
    for fund in data["funds"].values():
        ohlc, code = fund["ohlc"], fund["selected"]
        day = ohlc["date"]
        start = (date.fromisoformat(day) - timedelta(days=14)).isoformat()
        frame, report = fetch_daily(resolve_symbol(code, kind="index"), start, day, source=fund["source"])
        original = frame.set_index("date").loc[day]
        for key in ("open", "high", "low", "close"):
            if float(original[key]) != ohlc[key]:
                raise SystemExit(f"Source mismatch: {code} {day} {key}")
        if report["volume_unit"] != "100-share lots" or float(original.volume_lots) != fund["volume"]:
            raise SystemExit(f"Source mismatch: {code} {day} volume")
        fund["verified_last_ohlcv_against_provider"] = True
    args.observations.write_text(json.dumps(data, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")


if __name__ == "__main__":
    main()
