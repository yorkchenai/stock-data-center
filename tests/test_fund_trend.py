import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from scripts.audit_fund_sector_data import session_index
from stock_analysis.fund_trend import (DOWN, NEUTRAL, PRIMARY, UP, Confirmation, bars_from_history,
                                       combine, complete_periods, decisions, historical_selector, joint_target, known_state,
                                       trend_series)
from stock_analysis.fund_trend_backtest import (Execution, drawdown_metrics, historical_phases,
                                                order_schedule, run_strategies, segments, simulation)


class TrendResearchTests(unittest.TestCase):
    def test_weekly_bar_closes_on_last_session_before_friday_holiday(self):
        sessions = session_index("2026-04-20","2026-05-08")
        close = pd.Series(np.arange(len(sessions))+10.,index=sessions)
        raw = pd.DataFrame({"open":close-.1,"high":close+.3,"low":close-.4},index=sessions)
        weekly = bars_from_history(close,sessions,PRIMARY,raw)
        day = pd.Timestamp("2026-04-30")
        self.assertIn(day,weekly.index)
        week = close.loc["2026-04-27":"2026-04-30"]
        self.assertEqual(weekly.loc[day,"close"],week.iloc[-1])
        self.assertAlmostEqual(weekly.loc[day,"open"],week.iloc[0]-.1)
        self.assertAlmostEqual(weekly.loc[day,"high"],week.max()+.3)
        close.loc["2026-04-28"] = np.nan
        self.assertTrue(pd.isna(bars_from_history(close,sessions,PRIMARY).loc[day,"close"]))

    def test_trend_has_warmup_and_reports_missing_indicators(self):
        sessions = pd.bdate_range("2023-01-02",periods=380)
        levels = pd.Series(100*1.003**np.arange(len(sessions)),index=sessions)
        results = trend_series(levels,sessions,PRIMARY)
        self.assertIsNone(known_state(results,results.index[3],"weekly"))
        self.assertEqual(known_state(results,results.index[-1],"weekly"),UP)
        self.assertTrue(results.ADX14.isna().all())
        study = trend_series(levels,sessions,PRIMARY)
        truncated = trend_series(levels.iloc[:240],sessions,PRIMARY)
        pd.testing.assert_frame_equal(study.iloc[:48],truncated.iloc[:48])

    def test_vote_weights_and_joint_reentry_are_explicit(self):
        rows = [{"code":"large","score":3,"state":DOWN},{"code":"small1","score":1,"state":UP},
                {"code":"small2","score":1,"state":UP}]
        self.assertEqual(combine(rows,"vote")[0],UP)
        vote, weighted = combine(rows,"weighted")
        self.assertEqual(vote,DOWN)
        self.assertAlmostEqual(sum(item["weight"] for item in weighted),1)
        self.assertEqual(joint_target(UP,DOWN),.5)
        self.assertEqual(joint_target(DOWN,DOWN),0)
        confirmation = Confirmation(2)
        self.assertEqual([confirmation.update(value) for value in (0,0,1,1)], [.5,0,0,1])

    def test_historical_selection_and_signals_never_see_the_trade_date(self):
        days = pd.bdate_range("2025-01-01",periods=90)
        state = pd.DataFrame({"state":UP},index=complete_periods(days,"weekly"))
        calls = []
        def select(cutoff):
            calls.append(cutoff)
            return [{"code":"x","score":.4}]
        research = decisions(state,{"x":state},days,days[-1],PRIMARY,select)
        self.assertEqual(len(calls),len(set(day.to_period("M") for day in calls)))
        self.assertTrue(all(row["ranked_through"]<=row["known_through"]<row["decision"] for row in research))
        self.assertTrue(all(days.get_loc(row["decision"])-days.get_loc(row["known_through"])==2
                            for row in research))
        shifted = state.copy()
        shifted.loc[days[-20]:,"state"] = DOWN
        altered = decisions(shifted,{"x":state},days,days[-1],PRIMARY,select)
        self.assertEqual([r for r in research if r["known_through"]<days[-20]],
                         [r for r in altered if r["known_through"]<days[-20]])

    def test_association_reestimation_receives_only_the_visible_training_prefix(self):
        days = pd.bdate_range("2023-01-03",periods=650)
        data = pd.DataFrame({"__fund__":.01,"market":.02,"sector":.03},index=days)
        select = historical_selector(data,["market"],["sector"])
        with patch("stock_analysis.fund_trend.rank_associations",
                   return_value={"ranked":[{"code":"sector","score":.3}]}) as mocked:
            self.assertEqual(select(days[590]),[{"code":"sector","score":.3}])
            horizon = mocked.call_args.args[0]
            self.assertEqual(horizon.index[-1],days[590])
            self.assertEqual(len(horizon),504)
            select(days[590])
            self.assertEqual(mocked.call_count,1)

    def test_orders_mark_same_day_returns_before_the_fill_and_do_not_rebalance(self):
        days = pd.bdate_range("2026-01-05",periods=10)
        levels = pd.Series([1,1,2,2,2,3,3,3,3,3],index=days)
        rows = [{"decision":days[i],"targets":{"B":1}} for i in (1,4,7)]
        setup = Execution("test",subscription=0,redemption=0)
        schedule = order_schedule(days,rows,"B",setup,pd.DatetimeIndex([]))
        self.assertEqual(list(schedule),[2])
        path, trades, _ = simulation(levels,days,schedule,setup)
        self.assertAlmostEqual(path.value.loc[days[2]],1)
        self.assertAlmostEqual(path.value.iloc[-1],1.5)
        self.assertLess(trades[0]["signal"],trades[0]["date"])

    def test_short_age_and_settlement_block_funding_a_new_order(self):
        days = pd.bdate_range("2026-05-11",periods=10)
        levels = pd.Series(1.,index=days)
        orders = {0:(1,None),2:(0,days[1]),3:(1,days[2])}
        setup = Execution("test",subscription=0,redemption=0,settlement=3)
        path,trades,paid = simulation(levels,days,orders,setup)
        self.assertAlmostEqual(paid,.015)
        self.assertEqual(trades[-1]["date"],days[5])
        self.assertAlmostEqual(path.unsettled.iloc[3],1)
        self.assertAlmostEqual(path.cash.iloc[3],0)
        self.assertAlmostEqual(path.value.iloc[-1],.985)

    def test_known_pause_defers_to_later_close(self):
        days = pd.bdate_range("2026-05-11",periods=8)
        levels = pd.Series(1.,index=days)
        _,record,_=simulation(levels,days,{1:(1,days[0])},Execution("base"),
                              {days[1]:{"buy_blocked":True},days[2]:{"buy_blocked":True}})
        self.assertEqual(record[0]["date"],days[3])

    def test_metrics_count_entry_cost_and_do_not_cross_missing_NAV(self):
        days = pd.bdate_range("2024-01-01",periods=401)
        levels = pd.Series(100*1.003**np.arange(len(days)),index=days)
        levels.iloc[200] = np.nan
        self.assertEqual([len(index) for index in segments(levels)],[200,200])
        valid = levels.iloc[:200]
        execution = Execution("clean",subscription=0,redemption=0)
        _,_,reports = run_strategies(valid,days,[],execution,complete_periods(days,"monthly"))
        self.assertAlmostEqual(reports["A"]["phases"]["up"]["capture"],1)
        self.assertLess(reports["E"]["phases"]["up"]["capture"],1)
        self.assertEqual(len(historical_phases(valid)),3)
        _,dd = drawdown_metrics(pd.Series([1,.7,1,1.2,.9,.8],index=days[:6]))
        self.assertEqual(dd["max_drawdown_window"]["trough"],days[5].date().isoformat())
        self.assertIsNone(dd["max_drawdown_window"]["recovery"])
        self.assertAlmostEqual(dd["mdd"],1/1.5-1)
