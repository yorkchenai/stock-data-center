import { test } from "node:test";
import assert from "node:assert/strict";
import { indexCapabilities, navTimeline, normalizeChartFile, normalizeIndex } from "../web/funds/chart-data.mjs";

const dates=["2024-01-02","2024-01-03","2024-01-04","2024-01-05"];
const fund={
  schema_version:1,kind:"off_market_fund",code:"110022",name:"测试基金",
  category:"stock",return_basis:"event_reinvested",
  source:{name:"测试来源",method:"单位净值和事件",retrieved_at:"2024-02-02T00:00:00Z"},
  rows:dates.map((date,i)=>({date,unit_nav:[2,1.9,1.8,1.7][i],return_index:[1,1.02,null,1.1][i],
    return_issue:i===2?"cash_evidence_missing":null})),
};
const entry={
  code:"399997",name:"测试指数",rank:1,quality:"strong",beta:.52,stability:1,index_as_of:dates.at(-1),
  holdings:{status:"unverified"},
  windows:Object.fromEntries([60,120].map((n)=>[n,{count:n,partial_count:n,pearson:.8,partial:.7}])),
};
const history={
  schema_version:1,kind:"fund_sector_history",fund_code:fund.code,code:entry.code,name:entry.name,model_as_of:dates.at(-1),
  first:dates[0],last:dates.at(-1),currency:"CNY",basis:"price",volume_unit:"手",
  source:{name:"测试指数源",url:"https://example.test/prices"},
  rows:dates.map((date,i)=>({date,close:110+i,volume:800,VOL5:720,VOL10:690,MA5:105+i})),
};
const evidence={...history.source, volume_unit_evidence:"https://example.test/unit", volume:{
  raw_unit:"股",raw_field:"tradingVol",conversion_factor:.01,scope:"index_constituents",permission:"authorized_local_use",
}};
const pack={schema_version:1,kind:"fund_chart_bundle",fund,indices:[history],analysis:{
  schema_version:1,kind:"fund_sector_analysis",fund_code:fund.code,fund_as_of:dates.at(-1),model_as_of:dates.at(-1),
  computed_at:"2024-01-06T00:00:00Z",sectors:[entry],
}};

test("rebased adjusted NAV segments never bridge unresolved distributions",()=>{
  const prepared=navTimeline(normalizeChartFile(fund).fund,"adjusted");
  assert.deepEqual(prepared.segments.map((p)=>p.anchor),[dates[0],dates[3]]);
  assert.deepEqual(prepared.segments.map((p)=>p.points.map((v)=>v.value)),[[2,2.04],[1.7]]);
  assert.equal(prepared.gaps[0].date,dates[2]);
  assert.match(prepared.gaps[0].reason,/无法核验分红/);
  assert.equal(navTimeline(normalizeChartFile(fund).fund,"raw").segments.length,1);
});
test("static bundle verifies share, model day, sector, and expiry dates",()=>{
  const out=normalizeChartFile(pack);
  assert.equal(out.bundle.indexes.size,1);
  assert.throws(()=>normalizeChartFile({...pack,indices:[{...history,fund_code:"003095"}]}),/不一致/);
  assert.throws(()=>normalizeChartFile({...pack,indices:[{...history,model_as_of:dates[1]}]}),/不一致/);
  assert.throws(()=>normalizeChartFile({...pack,indices:[]}),/数量/);
});
test("known stock engine units display with no legacy authorization fields",()=>{
  const out=normalizeIndex({...history,volume_unit:null},fund.code,entry,history.model_as_of);
  assert.equal(out.volume_unit,null);
  assert.equal(out.rows[0].volume,null);
  assert.equal(out.rows[0].open,null);
  assert.deepEqual(indexCapabilities(out.rows,out.volume_unit),{candles:false,volume:false});
  const withUnit={...history,
    rows:history.rows.map((row)=>({...row,open:109,high:114,low:107}))};
  const audited=normalizeIndex(withUnit,fund.code,entry,history.model_as_of);
  assert.equal(audited.volume_unit,"手");
  assert.equal(audited.rows[0].volume,800);
  assert.deepEqual(indexCapabilities(audited.rows,audited.volume_unit),{candles:true,volume:true});
});
test("unknown units are excluded and display units do not require permission metadata",()=>{
  const wrong=normalizeIndex({...history,volume_unit:"斤"},fund.code,entry,history.model_as_of);
  assert.equal(wrong.volume_unit,null);
  assert.equal(wrong.rows[0].close,110);
  const raw={...history,source:{...history.source,volume_unit_evidence:"http://example.test/unit"}};
  const displayed=normalizeIndex(raw,fund.code,entry,history.model_as_of);
  assert.equal(displayed.volume_unit,"手");
  assert.equal(displayed.source.volume_unit_evidence,null);
});
test("independent chart cutoff may differ from the linked model index cutoff",()=>{
  const early={...history,last:dates[2],model_index_as_of:entry.index_as_of,rows:history.rows.slice(0,3)};
  const accepted=normalizeIndex(early,fund.code,entry,history.model_as_of);
  assert.equal(accepted.last,dates[2]);
  assert.equal(accepted.model_index_as_of,dates[3]);
  assert.throws(()=>normalizeIndex({...early,model_index_as_of:dates[1]},fund.code,entry,history.model_as_of),/覆盖日期/);
});
test("precomputed volume warmup restarts across missing or invalid rows without hiding candles",()=>{
  const sessions=["2024-01-02","2024-01-03","2024-01-04","2024-01-05","2024-01-08","2024-01-09",
    "2024-01-10","2024-01-11","2024-01-12","2024-01-15","2024-01-16","2024-01-17"];
  const last=sessions.at(-1);
  const raw={...history,source:evidence,last,rows:sessions.map((date,i)=>({date,open:109,high:118,low:107,close:110,
    volume:i===0?0:i===10?-1:800,VOL5:720,VOL10:690}))};
  const out=normalizeIndex(raw,fund.code,{...entry,index_as_of:last},history.model_as_of);
  assert.deepEqual(out.rows.map((row)=>row.volume),[0,...Array(9).fill(800),null,800]);
  assert.deepEqual(out.rows.map((row)=>row.VOL5),[...Array(4).fill(null),...Array(6).fill(720),null,null]);
  assert.deepEqual(out.rows.map((row)=>row.VOL10),[...Array(9).fill(null),690,null,null]);
  assert.equal(indexCapabilities(out.rows,out.volume_unit).candles,true);
});
test("partial or inverted OHLC cannot be accepted as a candle",()=>{
  const bad={...history,rows:[{...history.rows[0],open:100,high:90,low:80},...history.rows.slice(1)]};
  assert.throws(()=>normalizeIndex(bad,fund.code,entry,history.model_as_of),/开高低收/);
});
