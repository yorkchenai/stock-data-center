import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBenchmark, compareBenchmark } from "../web/funds/benchmark.mjs";
import { normalizeRiskFree, riskFreeReturns } from "../web/funds/risk-free.mjs";
import { normalizeFund } from "../web/funds/data.mjs";
import { analyzePerformance, selectWindow } from "../web/funds/performance.mjs";

const dates = ["2025-01-02","2025-01-03","2025-01-06","2025-01-07"];
const end = dates.at(-1);
const source = "测试披露及独立计算";
const rows = dates.map((date, i) => ({date,unit_nav:1,return_index:[100,110,99,108.9][i]}));
const component = (id, weight = 1, basis = "price") => ({id,weight,basis});
const series = (id, observations, options = {}) => ({
  id, source, basis:"price", rows:observations.map(([i,value]) => ({date:dates[i],value})), ...options,
});
const regime = (components, options = {}) => ({
  source, method:"daily_weighted", effective_from:dates[0], components, ...options,
});
const definition = (regimes, series, extras = {}) => ({official:true,name:"测试业绩基准",source,regimes,series,...extras});
const stock = series("stock",[[0,100],[1,120],[2,108],[3,120]]);
const bond = series("bond",[[0,100],[1,100],[2,110],[3,110]],{basis:"full_price"});
const compare = (data, samples = rows) => compareBenchmark(normalizeBenchmark(data,end),samples);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, actual + " != " + expected);

test("single official index rebases on exact fund dates, including a custom window", () => {
  const data = definition([regime([component("stock")],{method:"single_index"})],[stock]);
  const actual = compare(data,rows.slice(1));
  assert.equal(actual.status,"complete");
  assert.deepEqual(actual.points.map(({time}) => time),dates.slice(1));
  assert.equal(actual.points[0].value,0);
  near(actual.value,0);
});

test("daily rebalancing and period-end weighting are deliberately different", () => {
  const components = [component("stock",.6),component("bond",.4,"full_price")];
  const daily = compare(definition([regime(components)],[stock,bond]));
  const period = compare(definition([regime(components,{method:"period_weighted"})],[stock,bond]));
  near(daily.value,1.12 * .98 * (1 + .6 * (120/108-1)) - 1);
  near(period.value,.6 * .2 + .4 * .1);
  assert.notEqual(daily.value,period.value);
});

test("effective regimes switch both formula and weights on the return's ending date", () => {
  const data = definition([
    regime([component("stock")],{method:"single_index",effective_to:dates[1]}),
    regime([component("stock",.3),component("bond",.7,"full_price")],{method:"period_weighted",effective_from:dates[2]}),
  ],[stock,bond]);
  near(compare(data).value,1.2 * 1.07 - 1);
  const overlapping = {...data,regimes:[data.regimes[0],{...data.regimes[1],effective_from:dates[1]}]};
  assert.throws(() => compare(overlapping),/生效区间/);
  data.regimes[0] = {...data.regimes[0],method:"none",components:[]};
  assert.equal(compare(data).status,"unverified");
});

test("only a verified holiday calendar permits carrying a closed market level", () => {
  const restricted = series("bond",[[0,100],[2,102],[3,103]],{basis:"full_price",
    calendar:{source,from:dates[0],to:end,sessions:[dates[0],dates[2],dates[3]]}});
  const components = [component("stock",.6),component("bond",.4,"full_price")];
  const method = regime(components);
  const aligned = compare(definition([method],[stock,restricted]));
  assert.equal(aligned.status,"complete");
  near(aligned.points[1].value,.12);
  const openGap = {...restricted,calendar:{...restricted.calendar,sessions:dates}};
  assert.equal(compare(definition([method],[stock,openGap])).value,null);
  const holidayAtStart = compare(definition([method],[stock,restricted]),rows.slice(1));
  assert.equal(holidayAtStart.status,"complete");
  assert.equal(holidayAtStart.points[0].value,0);
});

test("wrong index basis, missing anchor and interior gaps cannot masquerade as a complete comparison", () => {
  const method = regime([component("stock")],{method:"single_index"});
  assert.match(compare(definition([method],[{...stock,basis:"total_return"}])).reason,/口径/);
  assert.equal(compare(definition([method],[{...stock,rows:stock.rows.slice(1)}])).points.length,0);
  const gap = compare(definition([method],[{...stock,rows:stock.rows.filter(({date}) => date !== dates[2])}]));
  assert.equal(gap.status,"partial");
  assert.equal(gap.value,null);
  assert.deepEqual(gap.points.map(({time})=>time),dates.slice(0,2));
});

test("disclosed return applies to the exact window and never fabricates a daily curve", () => {
  const official = {source,start:dates[0],end,return:.025};
  const data = definition([],[],{disclosed_periods:[official]});
  assert.equal(compare(data).status,"disclosed");
  assert.equal(compare(data).value,.025);
  assert.deepEqual(compare(data).points,[]);
  assert.equal(compare(data,rows.slice(1)).value,null);
  const inconsistent = definition([regime([component("stock")])],[stock],{disclosed_periods:[official]});
  assert.match(compare(inconsistent).reason,/官方披露结果不符/);
});

const history = {
  name:"测试三个月国债",source,convention:"simple_act_365f",effective_from:dates[0],effective_to:end,max_age_days:3,
  rows:[{date:dates[0],annual_rate:.0365},{date:dates[1],annual_rate:.073},{date:dates[2],annual_rate:.1095}],
};

test("historical rates use the interval's starting quote and calendar days, including weekends", () => {
  const simple = riskFreeReturns(normalizeRiskFree(history,end),rows,252).values;
  [0.0001,0.0006,0.0003].forEach((value,i) => near(simple[i],value));
  const compounded = riskFreeReturns(normalizeRiskFree({...history,convention:"effective_act_365f"},end),rows,252).values;
  near(compounded[1],1.073**(3/365)-1);
  const act360 = riskFreeReturns(normalizeRiskFree({...history,convention:"simple_act_360"},end),rows,252).values;
  near(act360[1],.073 * 3 / 360);
});

test("insufficient rate coverage, outdated quotes and invalid date order are distinct", () => {
  assert.match(riskFreeReturns(normalizeRiskFree({...history,effective_from:dates[1]},end),rows,252).reason,/覆盖/);
  assert.match(riskFreeReturns(normalizeRiskFree({...history,rows:history.rows.slice(1)},end),rows,252).reason,/2025-01-02/);
  assert.match(riskFreeReturns(normalizeRiskFree({...history,rows:history.rows.slice(0,1)},end),rows,252).reason,/过期/);
  assert.match(riskFreeReturns(normalizeRiskFree({...history,missing_dates:[dates[1]]},end),rows,252).reason,/日历要求/);
  assert.throws(()=>normalizeRiskFree({...history,rows:[...history.rows].reverse()},end),/日期/);
});

test("legacy rate fields and benchmark histories do not change active fund risk calculations", () => {
  const payload = {
    code:"000001",name:"测试基金",kind:"off_market_fund",schema_version:1,category:"mixed",valuation_frequency:"daily",
    source:{name:source,method:source,retrieved_at:"2025-01-08T00:00:00Z"},risk_free:history,rows,
    return_basis:"adjusted_nav",benchmark:definition([regime([component("stock")])],[stock]),
  };
  const fund = normalizeFund(payload);
  const actual = analyzePerformance(fund,selectWindow(fund,dates[0],end)).metrics;
  const withoutLegacy = normalizeFund({...payload,risk_free:null,benchmark:null});
  assert.deepEqual(actual,analyzePerformance(withoutLegacy,selectWindow(withoutLegacy,dates[0],end)).metrics);
  assert.equal(actual.excess,undefined);
  assert.equal(fund.benchmark.name,"测试业绩基准");
  assert.equal(fund.benchmark.seriesById.size,0);
  near(actual.drawdown.value,-.1);
});
