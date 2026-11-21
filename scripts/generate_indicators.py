"""Compatibility entry point using the saved 000688 CSV without refetching.

Optional CLI arguments use the same interface as python -m stock_analysis.
Outputs go into a new per-instrument run, preserving the original five PNGs.
"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from stock_analysis.pipeline import main

if __name__ == "__main__":
    arguments = sys.argv[1:] or [
        "000688", "--input", "results/000688_daily.csv", "--start", "2020-07-01"
    ]
    main(arguments)
