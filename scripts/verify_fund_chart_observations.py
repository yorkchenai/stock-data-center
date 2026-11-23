"""Cross-check a small set of rendered chart readings against the CSI source."""
from argparse import ArgumentParser
import json
from pathlib import Path

import numpy as np

from stock_analysis.sector_data import csi_history, read_catalog, read_with_transient_retry


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("observations", type=Path)
    args = parser.parse_args()
    data = json.loads(args.observations.read_text(encoding="utf-8"))
    catalog = read_catalog()
    for fund in data["funds"].values():
        ohlc, code = fund["ohlc"], fund["selected"]
        day = ohlc["date"]
        frame = read_with_transient_retry(lambda: csi_history(catalog[code], day, day))
        original = frame.loc[day]
        for key in ("open", "high", "low", "close"):
            audited = float(original[key]) if np.isfinite(original[key]) else None
            if audited != ohlc[key]:
                raise SystemExit(f"Source mismatch: {code} {day} {key}")
        fund["verified_last_ohlc_against_issuer"] = True
    args.observations.write_text(json.dumps(data, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")


if __name__ == "__main__":
    main()
