import unittest

import numpy as np
import pandas as pd

from scripts.audit_fund_sector_data import csi_history, read_catalog
from stock_analysis.indicators import calculate_indicators
from stock_analysis.sector_holdings import holdings_evidence
from stock_analysis.sector_model import FUND, alignment, correlations, fit_model, rank_associations
from stock_analysis.sector_signals import technical_series, technical_snapshot
from stock_analysis.sector_validation import DATA_LAG, HORIZONS, METHODS, future_return, make_fold, walk_forward


class SectorResearchTest(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(31)
        self.days = pd.bdate_range("2023-01-02", periods=435)
        market, industry, other = rng.normal(0,.012,(3,len(self.days)))
        self.returns = pd.DataFrame({"m":market,"a":market+industry,"b":market+industry*.99,
                                     "c":market+other,
                                     FUND:.7*market+.6*industry+rng.normal(0,.002,len(market))},index=self.days)

    def test_cash_adjusted_returns_and_open_session_gaps(self):
        days = self.days[:6]
        fund = {"category":"stock","valuation_frequency":"daily","return_basis":"event_reinvested",
                "rows":[{"date":day.date().isoformat(),"unit_nav":nav,"return_index":level,"return_issue":issue}
                        for day,nav,level,issue in zip(days,[1,.9,.92,1,1,1], [1,1.02,1.04,None,1.05,1.06],
                                                       [None,None,None,"unverified_event",None,None])]}
        index = pd.DataFrame({"close":[100,101,105,106,107]},index=days.delete(2))
        frame = alignment(fund,{"industry":index},days)
        self.assertAlmostEqual(frame[FUND].iloc[1],.02)
        self.assertTrue(frame.industry.iloc[2:4].isna().all())
        self.assertTrue(frame[FUND].iloc[3:5].isna().all())
        extra = pd.DataFrame({"close":[100]},index=[pd.Timestamp("2023-01-01")])
        with self.assertRaisesRegex(ValueError,"outside"):
            alignment(fund,{"industry":extra},days)

    def test_valid_weekend_nav_is_not_an_extra_market_session(self):
        sessions = pd.DatetimeIndex(["2026-06-26", "2026-06-29", "2026-06-30"])
        fund = {"category":"mixed","valuation_frequency":"daily","return_basis":"adjusted_nav",
                "rows":[{"date":date,"return_index":level}
                        for date,level in [("2026-06-26",1),("2026-06-28",1.02),
                                           ("2026-06-29",1.03),("2026-06-30",1.04)]]}
        aligned = alignment(fund,{},sessions)
        self.assertEqual(len(aligned),3)
        self.assertAlmostEqual(aligned[FUND].iloc[1],.03)
        fund["rows"][1]["return_issue"] = "unresolved_cash_event"
        excluded = alignment(fund,{},sessions)
        self.assertTrue(excluded[FUND].isna().all())

    def test_partial_removes_common_market_and_duplicate_exposures(self):
        controls = correlations(self.returns,"c",["m"],120)
        self.assertGreater(controls["pearson"], .3)
        self.assertLess(abs(controls["partial"]), .2)
        result = rank_associations(self.returns,["a","b","c"],["m"])
        ranked = result["ranked"]
        self.assertEqual(len(ranked),1)
        self.assertIn(ranked[0]["code"],["a","b"])
        self.assertGreater(ranked[0]["beta"],.4)
        self.assertEqual(ranked[0]["positive_fraction"],1)
        self.assertEqual(set(result["models"]),set(METHODS))

    def test_regularized_estimators_stay_finite_with_duplicate_factors(self):
        feature = self.returns.a.to_numpy()
        x = np.column_stack((feature,feature))
        y = feature*2
        ols = fit_model("ols",x,y)
        self.assertAlmostEqual(ols.slopes.sum(),2)
        self.assertGreater(ols.condition or 1e16,1e10)
        for model in ("ridge","elastic_net"):
            fit = fit_model(model,x,y)
            self.assertTrue(np.isfinite(fit.slopes).all())
            self.assertAlmostEqual(fit.slopes[0],fit.slopes[1],places=5)
            self.assertLess(fit.slopes.sum(),2)

    def test_windows_and_gaps_are_explicit(self):
        for rows in (12,65):
            result = rank_associations(self.returns.iloc[:rows],["a","b","c"],["m"])
            self.assertEqual(result["status"],"insufficient_coverage")
        missing = self.returns.copy()
        missing.loc[missing.index[-2],"a"] = np.nan
        output = correlations(missing,"a",["m"],60)
        self.assertEqual(output["count"],60)
        self.assertEqual(output["missing_in_lookback"],1)
        self.assertEqual(output["last"],missing.index[-1].date().isoformat())

    def test_stock_indicator_parity_and_missing_volume(self):
        close = pd.Series(100*(1+self.returns.a).cumprod(),index=self.days)
        raw = pd.DataFrame({"open":close,"high":close*1.01,"low":close*.99,"close":close,"volume":100.0})
        same = technical_series(raw,self.days,"shares")
        stock = raw.rename(columns={"volume":"volume_lots"}).assign(turnover_cny=200.0,date=self.days)
        expected = calculate_indicators(stock)
        for key in ("MA5","MA60","MACD_hist","RSI14","ADX14","+DI","-DI","VOL5"):
            np.testing.assert_allclose(same[key],expected[key],equal_nan=True)
        close_only = technical_series(raw[["close"]].drop(index=self.days[-10]),self.days)
        report = technical_snapshot(close_only,self.days[-1])
        self.assertEqual([row["layer"] for row in report["layers"]],
                         ["价格定位置","均线判趋势","成交量看配合","MACD看动量变化","RSI看相对强弱"])
        self.assertEqual(report["layers"][2]["status"],"unavailable")
        self.assertIsNone(report["layers"][1]["MA60"])
        self.assertEqual(report["ADX"]["status"],"unavailable")

    def test_point_in_time_holdings_and_total_assets_are_distinct(self):
        source = "https://example.com/portfolio.pdf"
        disclosures = [{"share_codes":["110022"],"period_end":"2025-06-30","disclosed_on":"2025-07-20",
                        "source":source,"stock_weight_pct_total_assets":90,
                        "top":[{"symbol":"sh600519","weight_pct_nav":9}]}]
        classification = {"sh600519":[{"indices":["399997"],"effective_from":"2025-06-30",
                                       "published_on":"2025-07-21","source":source}]}
        self.assertEqual(holdings_evidence("110022",disclosures,classification,read_catalog(),
                                           "2025-07-20")["status"],"unverified")
        now = holdings_evidence("110022",disclosures,classification,read_catalog(),"2025-07-22")
        self.assertEqual(now["sector_support"]["399997"]["known_weight_pct_nav"],9)
        self.assertEqual(now["stock_weight_pct_total_assets"],90)
        self.assertEqual(holdings_evidence("999999",disclosures,classification,read_catalog(),
                                           "2025-07-22")["status"],"unverified")

    def test_provider_code_and_exact_index_name_are_both_checked(self):
        import json
        dates = [{"tradeDate":"20260105","indexCode":"000905","indexNameCnAll":"中证小盘500指数",
                  "open":105,"close":100,"low":80,"high":110}]
        get = lambda url: json.dumps({"data":dates})
        good = csi_history(read_catalog()["000905"],"2026-01-05","2026-01-05",get)
        self.assertEqual(good.close.iloc[0],100)
        self.assertTrue(good.volume.isna().all())
        dates[0]["indexNameCnAll"]="相似的错误指数"
        with self.assertRaisesRegex(ValueError,"index_identity_mismatch"):
            csi_history(read_catalog()["000905"],"2026-01-05","2026-01-05",get)

    def test_targets_start_at_next_valuation_and_stop_at_gaps(self):
        growth = pd.Series([.01,.02,.03,.04,.05,.06],index=self.days[:6])
        target = future_return(growth,2)
        self.assertAlmostEqual(target.iloc[0],1.03*1.04-1)
        growth.iloc[2] = np.nan
        self.assertTrue(np.isnan(future_return(growth,2).iloc[0]))

    def test_training_labels_mature_before_first_prediction(self):
        y = future_return(self.returns[FUND],20)
        data = self.returns[["m","a"]].shift(DATA_LAG).assign(actual=y)
        regimes = pd.Series("rising",index=self.days)
        positions = pd.Series(np.arange(len(data)),index=self.days)
        fields = {"A":["m"],"B":["m"],"C":["m","a"]}

        def fold(frame):
            saved = {model:{20:[]} for model in METHODS}
            audit = make_fold(frame,positions,regimes,300,20,fields,saved)
            return audit,saved["ridge"][20][0]

        audit, result = fold(data)
        changed = data.copy()
        changed.loc[self.days[278:],"actual"] += .4
        second, after = fold(changed)
        self.assertEqual(len(result),len(after))
        np.testing.assert_allclose(result[["A","B","C"]],after[["A","B","C"]])
        self.assertLess(audit["last_training_label_matured_by"],audit["first_prediction"])
        self.assertEqual(audit,second)

    def test_forward_selects_sectors_on_earlier_data_only(self):
        tech = {key:technical_series(pd.DataFrame({"close":100*(1+self.returns[key]).cumprod()}),self.days)
                for key in ("m","a","b","c")}
        verified = walk_forward(self.returns,tech,["m"],["a","b","c"])
        self.assertGreater(len(verified["folds"]),0)
        earliest = verified["folds"][0]
        self.assertLess(earliest["selection_through"],earliest["horizons"][1]["first_prediction"])
        self.assertEqual(set(verified["models"]["ridge"]),set(HORIZONS))
        self.assertEqual(verified["status"],"retrospective_assumed_availability")
