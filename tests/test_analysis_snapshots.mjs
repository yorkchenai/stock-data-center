import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { analysisService } from "../worker/snapshots/service.mjs";
import { createSnapshotWorker } from "../worker/snapshots/worker.mjs";
import { createRecord, snapshotStore } from "../worker/snapshots/store.mjs";
import { marketTransport } from "../worker/snapshots/providers.mjs";
import { calculateIndicators } from "../web/engine.mjs";

const migration=readFileSync(new URL("../worker/snapshots/migrations/0001_analysis_snapshots.sql",import.meta.url),"utf8");
const now=Date.parse("2026-09-30T11:00:00Z");
const sessions=Array.from({length:200},(_,i)=>new Date(now-(199-i)*86_400_000).toISOString().slice(0,10))
  .filter((d)=>[1,2,3,4,5].includes(new Date(d).getUTCDay()));
const calendar={start:"2025-01-01",end:"2026-12-31",sessions};
const query={asset_type:"stock",symbol:"300078"};
const rows=sessions.map((date,i)=>({date,open:i+1,close:i+2,high:i+4,low:i+1,volume_lots:1000+i,turnover_cny:10000+i}));
const indicators=calculateIndicators(rows);
const data={status:"complete",source:{name:"test"},data_as_of:sessions.at(-1),quality:{},
  raw_data:{history:rows,stock:{instrument:{market:"sz",code:"300078",kind:"stock"}}},indicators:{rows:indicators},
  models:{technical_analysis:{status:"complete"}},summary:{latest:indicators.at(-1)}};

function database() {
  const db=new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(migration);
  const sessions=[];
  const connection=()=>{
    const api={
      withSession:(label)=>{sessions.push(label);return connection();},
      prepare:(sql)=>({bind:(...args)=>{
        const stmt=db.prepare(sql);
        const values=args.map((arg)=>arg instanceof ArrayBuffer?new Uint8Array(arg):arg);
        return {
          first:async()=>stmt.get(...values)??null,
          all:async()=>({results:stmt.all(...values)}),
          run:async()=>({meta:{changes:stmt.run(...values).changes}}),
        };
      }}),
      batch:async(statements)=>{
        db.exec("BEGIN");
        try {
          const result=[];
          for (const s of statements) result.push(await s.run());
          db.exec("COMMIT");
          return result;
        } catch(error) {db.exec("ROLLBACK");throw error;}
      },
    };
    return api;
  };
  return {connection,sessions,db};
}
const make=(compute,modelVersion="model-a",clock=()=>new Date(now))=>analysisService({compute,calendar,modelVersion,clock});
const detail=(snapshot,category,extra={})=>({...query,snapshot_id:snapshot.snapshot_id,category,...extra});

test("D1 publication is immutable, pinned details use primary, latest hits avoid all extra builds",async()=>{
  const {connection,sessions}=database();
  let builds=0;
  const compute=async()=>{builds++;return data;};
  const server=make(compute);
  const one=await server.initial(connection(),query);
  assert.equal(one.cache,"miss");
  assert.equal(one.status,"complete");
  const another=make(compute);
  assert.equal((await another.initial(connection(),query)).snapshot_id,one.snapshot_id);
  const checks=[
    ["history",{limit:20},(v)=>assert.deepEqual(v.data.rows,rows.slice(-20))],
    ["history",{date:rows[2].date},(v)=>assert.deepEqual(v.data.rows,[rows[2]])],
    ["history",{limit:20,field:"high",aggregate:"max"},(v)=>assert.equal(v.data.extreme.value,rows.at(-1).high)],
    ["history",{start:rows[0].date,end:rows.at(-1).date,field:"low",aggregate:"min"},(v)=>
      assert.deepEqual(v.data.extreme,{date:rows[0].date,value:rows[0].low})],
    ["indicators",{date:rows.at(-1).date},(v)=>assert.equal(v.data.rows[0].MACD_hist,indicators.at(-1).MACD_hist)],
    ["model",{},(v)=>assert.equal(v.data.models.technical_analysis.status,"complete")],
  ];
  for (const [category,args,check] of checks) {
    const value=await another.details(connection(),detail(one,category,args));
    assert.equal(value.snapshot_id,one.snapshot_id);
    check(value);
  }
  assert.equal(builds,1);
  const refreshed=await another.initial(connection(),{...query,refresh:true});
  assert.notEqual(one.snapshot_id,refreshed.snapshot_id);
  assert.equal((await another.details(connection(),detail(one,"history"))).snapshot_id,one.snapshot_id);
  const upgrade=make(compute,"model-b");
  assert.equal((await upgrade.details(connection(),detail(one,"model"))).model_version,"model-a");
  assert.notEqual((await upgrade.initial(connection(),query)).snapshot_id,refreshed.snapshot_id);
  assert.deepEqual(new Set(sessions),new Set(["first-primary"]));
  assert.equal((await another.details(connection(),{...detail(one,"history"),symbol:"600519"})).status,"snapshot_not_found");
});

test("independent services share a D1 lease, background building finishes and expiry does not fetch",async()=>{
  const {connection}=database();
  let builds=0,complete;
  const pending=new Promise((resolve)=>{complete=resolve;});
  const server=make(async()=>{builds++;return pending;});
  let background;
  const ready=await server.initial(connection(),query,{waitUntil:(promise)=>{background=promise;},waitMs:1});
  assert.equal(ready.status,"building");
  assert.equal(ready.snapshot_id,undefined);
  assert.equal((await make(()=>assert.fail("duplicate build")).initial(connection(),query)).status,"building");
  complete(data);
  const first=await background;
  assert.ok(first.snapshot_id);
  const later=make(async()=>({ ...data,status:"partial" }),"model-a",()=>new Date(now+5*3_600_000));
  assert.equal((await later.details(connection(),detail(first,"history"))).status,"expired");
  const replacement=await later.initial(connection(),query);
  assert.equal(replacement.status,"partial");
  assert.notEqual(replacement.snapshot_id,first.snapshot_id);
  assert.equal(builds,1);
});

test("failed sources and absent cache never present an ID",async()=>{
  const {connection}=database();
  const server=make(()=>{throw new Error("provider unavailable");});
  assert.deepEqual((await server.initial(connection(),query)).status,"data_unavailable");
  assert.equal((await server.initial(undefined,query)).status,"cache_unavailable");
  assert.equal((await make(()=>assert.fail("failure cooldown")).initial(connection(),query)).status,"data_unavailable");
  const recovered=await make(async()=>data,"model-a",()=>new Date(now+16_000)).initial(connection(),query);
  assert.equal(recovered.cache,"miss");
});

test("refresh continuation waits for a newer ID and never starts another build",async()=>{
  const {connection}=database();
  const previous=await make(async()=>data).initial(connection(),query);
  let complete, builds=0, background;
  const pending=new Promise((resolve)=>{complete=resolve;});
  const server=make(async()=>{builds++;return pending;});
  const initial=await server.initial(connection(),{...query,refresh:true},{
    waitUntil:(p)=>{background=p;},waitMs:1,
  });
  assert.equal(initial.status,"building");
  assert.equal(initial.after_snapshot_id,previous.snapshot_id);
  assert.equal((await server.initial(connection(),query)).snapshot_id,previous.snapshot_id);
  const poll={...query,after_snapshot_id:initial.after_snapshot_id};
  const waiting=await server.initial(connection(),poll);
  assert.equal(waiting.status,"building");
  assert.equal(waiting.snapshot_id,undefined);
  assert.equal((await server.initial(connection(),{...poll,refresh:true})).status,"invalid_arguments");
  assert.equal((await server.initial(connection(),{...poll,symbol:"600519"})).status,"snapshot_not_found");
  complete(data);
  const published=await background;
  const result=await server.initial(connection(),poll);
  assert.notEqual(result.snapshot_id,previous.snapshot_id);
  assert.equal(result.snapshot_id,published.snapshot_id);
  assert.equal(builds,1);
});

test("refresh failure never masquerades as an earlier cached result",async()=>{
  const {connection}=database();
  const previous=await make(async()=>data).initial(connection(),query);
  const failure=make(async()=>{throw new Error("upstream unavailable");});
  assert.equal((await failure.initial(connection(),{...query,refresh:true})).status,"data_unavailable");
  const poll={...query,after_snapshot_id:previous.snapshot_id};
  assert.equal((await failure.initial(connection(),poll)).status,"data_unavailable");
  assert.equal((await failure.initial(connection(),query)).snapshot_id,previous.snapshot_id);
  const later=make(()=>assert.fail("continuation cannot build"),"model-a",()=>new Date(now+16_000));
  assert.equal((await later.initial(connection(),poll)).status,"refresh_not_found");
});

test("browser authorization, legacy stock fields and snapshot details use the same ID and values", async()=>{
  const {connection}=database();
  const db=connection();
  const events=[];
  const app=createSnapshotWorker({calendar,config:{},modelVersion:"model-a",clock:()=>new Date(now),
    authorize:(request)=>request.headers.get("Authorization")==="testing",
    authorizePage:(request)=>request.headers.get("Authorization")==="page-testing",
    compute:async(args,{onUpstream})=>{
      assert.equal(args.start,"2025-01-01");
      onUpstream({provider:"fixture",http:200});
      return data;
    },observe:(event)=>events.push(event)});
  const mcp=(name,args,auth="testing")=>app.fetch(new Request("https://preview.invalid/mcp",{
    method:"POST",headers:{Authorization:auth},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}),
  }),{DB:db}).then((p)=>p.json()).then((p)=>p.result.structuredContent);
  const page=(args,origin="https://allowed.invalid",auth="page-testing")=>app.fetch(new Request(
    "https://preview.invalid/api/analysis?"+new URLSearchParams(args),{headers:{Origin:origin,Authorization:auth}}),{
    DB:db,SNAPSHOT_PUBLIC_ORIGIN:"https://allowed.invalid",SNAPSHOT_PUBLIC_SYMBOLS:"stock:sz300078",
  });
  assert.equal((await mcp("get_stock_analysis",{symbol:"300078"},"invalid")).status,"unauthorized");
  const summary=await mcp("get_stock_analysis",{symbol:"300078"});
  assert.equal(summary.latest.MA5,indicators.at(-1).MA5);
  assert.equal(summary.status,"ok");
  assert.equal(summary.snapshot_status,"complete");
  assert.equal(summary.source,"test");
  assert.deepEqual(summary.rows,indicators.slice(-60));
  const historicalPage=await mcp("get_stock_analysis",{symbol:"300078",start:sessions[0]});
  assert.equal(historicalPage.snapshot_id,summary.snapshot_id);
  assert.deepEqual(historicalPage.rows,indicators.slice(-120));
  assert.equal(historicalPage.more,true);
  assert.ok(historicalPage.next_end<historicalPage.rows[0].date);
  assert.equal(historicalPage.units.volume_lots,"手");
  assert.equal((await page(query,"https://wrong.invalid")).status,403);
  assert.equal((await page(query,"https://allowed.invalid","missing-identity")).status,403);
  const res=await page({...detail(summary,"page")});
  assert.equal(res.headers.get("Access-Control-Allow-Origin"),"https://allowed.invalid");
  const view=await res.json();
  const followup=await mcp("get_analysis_details",detail(summary,"indicators",{limit:1}));
  assert.equal(view.snapshot_id,followup.snapshot_id);
  assert.deepEqual(view.data.rows,indicators);
  assert.equal(view.data.rows.at(-1).ADX14,followup.data.rows[0].ADX14);
  const source=events.filter((event)=>event.event==="snapshot_upstream");
  const reads=events.filter((event)=>event.event==="snapshot_read");
  assert.equal(source.length,1);
  assert.equal(source[0].request_id,events.find((event)=>event.event==="snapshot_publish").request_id);
  assert.equal(reads.length,2);
  assert.ok(reads.every((event)=>event.upstream_requests===0&&event.request_id!==source[0].request_id));
  assert.equal((await page({...detail(summary,"page"),symbol:"600519"})).status,403);
});

test("private same-origin access requires identity and has a separate D1 quota",async()=>{
  const {db,connection}=database();
  const env={DB:connection()};
  const authorized=(request)=>request.headers.get("Authorization")==="owner-fixture";
  let builds=0;
  const app=createSnapshotWorker({calendar,modelVersion:"model-a",clock:()=>new Date(now),
    pageAccess:(request)=>authorized(request)?{}:null,authorize:authorized,observe:()=>{},
    compute:async()=>{builds++;return data;}});
  const url="https://example.test/api/analysis?asset_type=stock&symbol=300078";
  const headers={Authorization:"owner-fixture"};
  assert.equal((await app.fetch(new Request(url,{headers:{Origin:"https://example.test"}}),env)).status,403);
  assert.equal(builds,0);
  const allowed=await app.fetch(new Request(url,{headers}),env);
  assert.equal(allowed.status,200);
  assert.equal(allowed.headers.has("Access-Control-Allow-Origin"),false);
  const {snapshot_id}=await allowed.json();
  const pinned=url+"&category=page&snapshot_id="+snapshot_id;
  assert.equal((await app.fetch(new Request(pinned),env)).status,403);
  assert.equal((await app.fetch(new Request(pinned,{headers}),env)).status,200);
  db.exec("UPDATE analysis_snapshot_limits SET calls=60,minute=unixepoch()/60 WHERE slot='page'");
  const limited=await app.fetch(new Request(pinned,{headers}),env);
  assert.equal(limited.status,429);
  assert.equal((await limited.json()).status,"rate_limited");
  const rpc=await app.fetch(new Request("https://example.test/mcp",{method:"POST",headers,
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",
      params:{name:"get_stock_analysis",arguments:{symbol:"300078"}}})}),env);
  assert.equal((await rpc.json()).result.structuredContent.snapshot_id,snapshot_id);
  assert.equal(builds,1);
});

test("fund keeps the v10 summary with a separate partial snapshot status and no history in speech", async()=>{
  const {connection}=database();
  const source={name:"test fund provider",method:"confirmed_nav",retrieved_at:new Date(now).toISOString()};
  const drawdown={value:-.15,reason:null};
  const fund={...data,status:"partial",source,quality:{freshness:"已确认披露"},
    models:{risk:{windows:{"1y":{start:sessions[0],end:sessions.at(-1)}}},
      sectors:{report:{model_as_of:sessions.at(-1),sectors:[{code:"399997",rank:1}]}}},
    summary:{name:"test fund",category:"stock",last_confirmed_nav_date:sessions.at(-1),latest_nav:2.5,
      returns:{"1y":{value:0.2,reason:null}},max_drawdown:drawdown,sector_status:"ok",
      sectors:[{code:"399997",name:"test sector",last_index_trade_date:sessions.at(-2)}]}};
  const worker=createSnapshotWorker({calendar,modelVersion:"model-a",clock:()=>new Date(now),
    authorize:()=>true,compute:async()=>fund,observe:()=>{}});
  const response=await worker.fetch(new Request("https://preview.invalid/mcp",{method:"POST",
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"get_fund_analysis",arguments:{symbol:"110022"}}}),
  }),{DB:connection()});
  const {result}=await response.json();
  const summary=result.structuredContent;
  assert.equal(result.isError,false);
  assert.equal(summary.status,"partial");
  assert.equal(summary.snapshot_status,"partial");
  assert.equal(summary.freshness,"已确认披露");
  assert.deepEqual(summary.max_drawdown,{...drawdown,start:sessions[0],end:sessions.at(-1)});
  assert.deepEqual(summary.source,source);
  assert.equal(summary.sectors[0].rank,1);
  assert.equal(summary.sectors[0].last_index_trade_date,sessions.at(-2));
  assert.notEqual(summary.last_confirmed_nav_date,summary.sectors[0].last_index_trade_date);
  assert.equal(Object.hasOwn(JSON.parse(result.content[0].text),"rows"),false);
});

test("records enforce raw limit and multi-chunk reads preserve exact numbers",async()=>{
  const {connection}=database();
  const store=snapshotStore(connection());
  const snap={schema_version:1,snapshot_id:crypto.randomUUID(),asset_type:"fund",symbol:"006751",
    expires_at:new Date(now+10_000).toISOString(),
    history:Array.from({length:32_000},()=>[crypto.randomUUID(),crypto.randomUUID(),Math.random()])};
  const bytes=await createRecord(snap);
  assert.ok(bytes.chunks.length>1);
  const key="chunk-test",token=await store.lease(key,now);
  await store.publish(key,token,snap,bytes,now);
  assert.deepEqual(await store.latest(key,now),snap);
  await assert.rejects(createRecord({text:" ".repeat(20_000_001)}),/超出/);
});

test("outbound transport rejects redirects and records actual response codes",async()=>{
  const seen=[];
  const read=marketTransport(async()=>Response.redirect("https://unexpected.invalid"),(event)=>seen.push(event));
  await assert.rejects(read("https://fund.eastmoney.com/pingzhongdata/110022.js"),/重定向/);
  await assert.rejects(read("https://fund.eastmoney.com.evil.invalid/pingzhongdata/110022.js"),/不支持/);
  assert.deepEqual(seen.map(({http})=>http),[302]);
});
