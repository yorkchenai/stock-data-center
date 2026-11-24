"""Numerical parity for the portable browser ranking on identical inputs."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest

import numpy as np
import pandas as pd

from stock_analysis.sector_model import alignment, rank_associations

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "Node is required for browser/Python parity")
class FundBrowserParity(unittest.TestCase):
    def test_association_windows_models_ranking_and_missing_data(self):
        rng = np.random.default_rng(623)
        dates = pd.bdate_range("2024-01-02", periods=280)
        sessions = dates.strftime("%Y-%m-%d").tolist()
        returns = rng.normal(0, .012, (len(dates), 7))
        markets = ["000300", "000905"]
        candidates = ["000991", "000994", "399997", "932139"]
        codes = markets + candidates
        returns[:, 4] = .95 * returns[:, 2] + .12 * returns[:, 4]
        fund_returns = returns[:, 0] * .2 + returns[:, 2] * .7 + returns[:, 3] * .35 + returns[:, 6] * .16
        fund = {"category": "mixed", "valuation_frequency": "daily", "return_basis": "event_reinvested",
                "rows": [{"date": d, "return_index": float(v)} for d, v in zip(sessions, np.cumprod(1 + fund_returns))]}
        fund["rows"][-12]["return_index"] = None
        series = {k: [{"date": d, "close": float(v)} for i, (d,v) in enumerate(zip(sessions, np.cumprod(1 + returns[:, col])))
                      if i not in [85, 182]] for col,k in enumerate(codes)}
        histories = {k: pd.DataFrame(v).set_index("date") for k,v in series.items()}
        evidence = {"000994": {"supportible": True}}
        expected = rank_associations(alignment(fund,histories,dates), candidates, markets, evidence)
        payload = {"fund":fund,"series":series,"sessions":sessions,"candidates":candidates,"markets":markets,"evidence":evidence}
        script = """
          import {readFileSync} from 'node:fs';
          import {alignSectorReturns,rankAssociations} from './web/funds/sector-model.mjs';
          const {fund,series,sessions,candidates,markets,evidence}=JSON.parse(readFileSync(0,'utf8'));
          console.log(JSON.stringify(rankAssociations(alignSectorReturns(fund,series,sessions),candidates,markets,evidence)));
        """
        result = subprocess.run(["node","--input-type=module","-e",script],cwd=ROOT,input=json.dumps(payload),
                                capture_output=True,text=True,check=True)
        actual = json.loads(result.stdout)
        self.assertTrue(expected["ranked"])
        self.compare(expected,actual)

    def compare(self, expected, actual):
        if isinstance(expected, dict):
            self.assertEqual({str(k) for k in expected},set(actual))
            for key, value in expected.items():
                self.compare(value,actual[str(key)])
        elif isinstance(expected, list):
            self.assertEqual(len(expected),len(actual))
            for left, right in zip(expected,actual):
                self.compare(left,right)
        elif isinstance(expected, float):
            self.assertAlmostEqual(expected,actual,delta=max(1e-9,abs(expected)*1e-9))
        else:
            self.assertEqual(expected,actual)
