import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFund, searchCatalog, fundFreshness } from "../web/funds/data.mjs";
import { analyzePerformance, periodReturn, periodStart, selectWindow } from "../web/funds/performance.mjs";

const dates = ["2025-01-02","2025-01-03","2025-01-06","2025-01-07"];
const fixture = (overrides = {}) => ({
  schema_version:1,kind:"off_market_fund",synthetic:true,code:"000001",name:"测试基金",category:"mixed",
  inception:"2025-01-02",valuation_frequency:"daily",return_basis:"event_reinvested",
  source:{name:"测试数据",method:"测试总回报",retrieved_at:"2025-01-08T01:00:00Z"},
  risk_free:{source:"手算测试利率",annual_rate:1.0001**252-1,effective_from:"2025-01-01",effective_to:"2025-12-31"},
  benchmark:{official:true,name:"测试基准",source:"测试数据",rows:dates.map((date,i)=>({date,value:[100,103,102,105][i]}))},
  rows:dates.map((date,i)=>({date,unit_nav:[1,1.1,.99,1][i],accumulated_nav:203+i,
    return_index:[100,110,99,108.9][i]})),
  ...overrides,
});
const near = (value, expected) => assert.ok(Math.abs(value-expected)<1e-10,`Expected ${expected}, got ${value}`);

test("positive ending return with an interim drawdown: all core metrics match independent arithmetic", () => {
  const fund = normalizeFund(fixture());
  const {metrics,points} = analyzePerformance(fund,selectWindow(fund,null,dates.at(-1)));
  const sampleSigma = Math.sqrt((2 * (1/15) ** 2 + (2/15) ** 2) / 2);
  near(metrics.return.value,.089);
  near(metrics.annualReturn.value,1.089**(365.2425/5)-1);
  near(metrics.drawdown.value,-.1);
  near(metrics.volatility.value,sampleSigma*Math.sqrt(252));
  near(metrics.sharpe.value,((1/30)-.0001)*Math.sqrt(252)/sampleSigma);
  near(metrics.sortino.value,((1/30)/Math.sqrt(.01/3))*Math.sqrt(252));
  near(metrics.excess.value,.039);
  near(metrics.calmar.value,metrics.annualReturn.value/.1);
  assert.equal(metrics.drawdownDays.value,3);
  assert.match(metrics.recoveryDays.reason,/尚未恢复/);
  assert.equal(points.fund[0].value,0);
  assert.equal(points.benchmark[0].value,0);
  near(points.drawdown[2].value,-.1);
});

test("calendar cutoffs clamp leap days and use the prior available NAV", () => {
  assert.equal(periodStart("2024-03-31","1m"),"2024-02-29");
  assert.equal(periodStart("2024-02-29","1y"),"2023-02-28");
  assert.equal(periodStart("2025-01-07","1w"),"2024-12-31");
  const fund = normalizeFund(fixture());
  const range = selectWindow(fund,"2025-01-05","2025-01-07");
  assert.equal(range.start,"2025-01-03");
  assert.equal(range.end,"2025-01-07");
  assert.equal(periodReturn(fund,"5y").value,null);
  assert.match(periodReturn(fund,"5y").reason,/历史覆盖不足/);
  assert.ok(selectWindow(fund,"2025-01-07","2025-01-02").error);
  assert.throws(()=>selectWindow(fund,"2025-02-30","2025-03-01"));
});

test("the seven list return periods use their own anchor and no inception substitution", () => {
  const rows = ["2020-12-31","2022-12-30","2024-12-31","2025-06-30","2025-09-30",
    "2025-11-28","2025-12-24","2025-12-31"].map((date,i)=>({date,unit_nav:100+i,return_index:100+i}));
  const fund = normalizeFund(fixture({inception:"2020-12-31",rows,benchmark:null,
    source:{name:"测试",method:"测试",retrieved_at:"2026-01-02T00:00:00Z"}}));
  const expected = {"1w":106,"1m":105,"3m":104,"6m":103,"1y":102,"3y":101,"5y":100};
  for (const [period,anchor] of Object.entries(expected)) near(periodReturn(fund,period).value,107/anchor-1);
});

test("no unverified totals, generic benchmark, invented risk-free rate, or special-fund daily metrics", () => {
  const input = fixture({risk_free:null,benchmark:null});
  const fund = normalizeFund(input);
  const window = selectWindow(fund,null,dates.at(-1));
  const base = analyzePerformance(fund,window);
  assert.match(base.metrics.sharpe.reason,/缺少/);
  assert.match(base.metrics.excess.reason,/官方业绩基准/);
  assert.equal(base.points.benchmark.length,0);
  const special = normalizeFund({...input,category:"money"});
  assert.equal(analyzePerformance(special,window).metrics.volatility.value,null);
  const misaligned = normalizeFund(fixture({benchmark:{...fixture().benchmark,rows:fixture().benchmark.rows.slice(1)}}));
  assert.equal(analyzePerformance(misaligned,window).metrics.excess.value,null);
  const absent = normalizeFund({...input,return_basis:"unavailable",rows:input.rows.map(({date,unit_nav})=>({date,unit_nav}))});
  assert.equal(analyzePerformance(absent,selectWindow(absent,null,dates.at(-1))).metrics.return.value,null);
  const broken = normalizeFund({...input,rows:input.rows.map((r,i)=>i===2?{...r,return_index:null}:r)});
  assert.equal(analyzePerformance(broken,selectWindow(broken,null,dates.at(-1))).points.fund.length,0);
});

test("zero variance and downside are handled, and recovery is measured in calendar days", () => {
  const flat = normalizeFund(fixture({rows:fixture().rows.map((row)=>({...row,return_index:100}))}));
  const flatMetrics = analyzePerformance(flat,selectWindow(flat,null,dates.at(-1))).metrics;
  assert.equal(flatMetrics.volatility.value,0);
  assert.match(flatMetrics.sharpe.reason,/为零/);
  assert.match(flatMetrics.sortino.reason,/为零/);
  const recover = normalizeFund(fixture({rows:fixture().rows.map((row,i)=>i===3?{...row,return_index:111}:row)}));
  assert.equal(analyzePerformance(recover,selectWindow(recover,null,dates.at(-1))).metrics.recoveryDays.value,1);
});

test("data contract checks namespace, chronology, metadata and search order", () => {
  const snapshot=fixture();
  assert.throws(()=>normalizeFund({...snapshot,kind:"stock"}),/场外基金/);
  assert.throws(()=>normalizeFund({...snapshot,inception:"2025-01-03"}),/日期|越界/);
  assert.throws(()=>normalizeFund({...snapshot,rows:[snapshot.rows[1],snapshot.rows[0]]}),/重复或越界/);
  assert.throws(()=>normalizeFund({...snapshot,benchmark:{...snapshot.benchmark,official:false}}),/正式业绩比较基准/);
  assert.equal(fundFreshness(normalizeFund(snapshot)),"测试数据");
  const imported = normalizeFund({...snapshot,synthetic:false});
  assert.match(fundFreshness(imported,"2025-01-20"),/超过 7 天/);
  const catalog=new Map([["123456",{code:"123456",name:"测试基金二",alias:"a"}],["000001",{code:"000001",name:"测试基金",alias:"b"}]]);
  assert.deepEqual(searchCatalog(catalog,"测试").map(({code})=>code),["000001","123456"]);
  assert.equal(searchCatalog(catalog,"000001")[0].code,"000001");
});

test("reconciled dividend preserves the adjusted path and gap reasons reach the period", () => {
  const input = fixture();
  const prices = [1.2, 1.14, 1.16, 1.18];
  const indices = [1, 1.21/1.2, (1.21/1.2)*(1.16/1.14), (1.21/1.2)*(1.18/1.14)];
  const rows = input.rows.map((row,i) => ({
    ...row, unit_nav:prices[i], return_index:indices[i], cash_distribution:i===1 ? .07 : 0,
  }));
  const fund = normalizeFund({...input,rows});
  const stats = analyzePerformance(fund,selectWindow(fund,null,dates.at(-1))).metrics;
  assert.equal(stats.drawdown.value,0);
  assert.ok(stats.volatility.value>0);
  near(stats.return.value,indices.at(-1)-1);
  rows[1] = {...rows[1],return_index:null,return_issue:"cash_evidence_mismatch"};
  const broken = normalizeFund({...input,rows});
  const incomplete = analyzePerformance(broken,selectWindow(broken,null,dates.at(-1))).metrics;
  assert.equal(incomplete.drawdown.value,null);
  assert.match(incomplete.return.reason,/2025-01-03.*无法核对/);
});
