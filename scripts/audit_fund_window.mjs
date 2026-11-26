// Send aggregate results and window boundaries back to the Python audit process.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
const root = process.argv[2];
const moduleUrl = (name) => pathToFileURL(path.join(root,"web","funds",name)).href;
const {normalizeFund} = await import(moduleUrl("data.mjs"));
const {periodStart,periodReturn,selectWindow,analyzePerformance,FUND_RISK_REFERENCE} = await import(moduleUrl("performance.mjs"));
const codes = ["return","drawdown","sharpe","volatility","sortino"];
const {data, asOf} = JSON.parse(readFileSync(0,"utf8"));
const started = performance.now();
const fund = normalizeFund(data);
const normalization_ms = performance.now() - started;
const last = fund.rows.at(-1).date;
const end = asOf && asOf < last ? asOf : last;
const startTime = performance.now();
const windows = Object.fromEntries(["1m","3m","6m","1y","3y","5y","all"].map((key) => {
  const start = key === "all" ? null : periodStart(end,key);
  const window = selectWindow(fund,start,end);
  const analysis = analyzePerformance(fund,window);
  return [key,{requested_start:start,start:window.start,end:window.end,error:window.error ?? null,
    observations:window.rows.length, timing_ms:performance.now() - startTime,
    metrics:Object.fromEntries(codes.map(key => [key,analysis.metrics[key]]))}];
}));
console.log(JSON.stringify({normalization_ms,normal_frequency:fund.normalFrequency,reference:FUND_RISK_REFERENCE??null,
  elapsed_ms:performance.now()-startTime, windows,
  list:{...Object.fromEntries(["1m","3m","6m","1y","3y","5y"].map(key=>[key, periodReturn(fund,key)]))}}));
