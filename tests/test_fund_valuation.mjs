import assert from "node:assert/strict";
import test from "node:test";
import { eastmoneyValuation, sinaValuation } from "../web/funds/valuation.mjs";

const now = "2026-11-26 12:24:00";

test("Eastmoney validates fund identity and both fields and rejects stale or future timestamps",()=>{
  const row = {FCODE:"014194", GSZ:1.2297, GSZZL:-1.06, GZTIME:"2026-11-26 11:30", NAV:1.2429, PDATE:"2026-11-25"};
  const parse = (override)=>eastmoneyValuation({success:true,data:[{...row,...override}]},"014194",now);
  assert.deepEqual(parse({}).map(({value,change,updatedAt})=>[value,change,updatedAt]),[[1.2297,-1.06,row.GZTIME]]);
  for (const override of [{GZTIME:"2026-11-25 15:00"},{GZTIME:"2026-11-26 12:25"},{GSZ:null},
    {GSZZL:""},{FCODE:"018993"},{GSZZL:false},{GSZ:0},{GZTIME:null}]) assert.deepEqual(parse(override),[]);
});

test("Sina returns separate last valid same-day points and converts growth rates into percent units",()=>{
  const payload = {result:{status:{code:0},data:{symbol:"018993",networth:[
    {pre_date:"2026-11-26",min_time:"11:33:00",pre_nav:"2.4485",growthrate:"0.011762",pre_nav2:"2.4683",growthrate2:"0.01996"},
    {pre_date:"2026-11-25",min_time:"15:00:00",pre_nav:"2.5",growthrate:"0.05",pre_nav2:"2.5",growthrate2:"0.05"},
    {pre_date:"2026-11-26",min_time:"11:34:00",pre_nav:"2.4490",growthrate:"0.012",pre_nav2:"--",growthrate2:"0"},
  ]}}};
  const values = sinaValuation(payload,"018993",now);
  assert.deepEqual(values.map(({id,value,updatedAt})=>[id,value,updatedAt]),[
    ["sina_ds2",2.449,"2026-11-26 11:34:00"],
    ["sina_ds3",2.4683,"2026-11-26 11:33:00"],
  ]);
  assert.equal(values[0].change,1.2);
  assert.ok(Math.abs(values[1].change-1.996)<1e-12);
  assert.deepEqual(sinaValuation(payload,"018993","2026-11-27 11:30:00"),[]);
  assert.throws(()=>sinaValuation(payload,"110022",now));
});
