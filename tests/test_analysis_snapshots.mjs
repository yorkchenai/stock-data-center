import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { analysisService } from "../worker/snapshots/service.mjs";
import { createSnapshotWorker } from "../worker/snapshots/worker.mjs";
import { mountSnapshotSite } from "../worker/snapshots/site-gateway.mjs";
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
  const shortStart=sessions.at(-20);
  assert.equal((await (await page({...query,start:shortStart,end:sessions.at(-1)})).json()).snapshot_id,summary.snapshot_id);
  const short=await mcp("get_stock_analysis",{symbol:"300078",start:shortStart,end:sessions.at(-1)});
  assert.equal(short.snapshot_id,summary.snapshot_id);
  assert.deepEqual(short.rows,indicators.slice(-20));
  assert.equal(short.recent_20_trading_days.lowest_intraday.date,shortStart);
  assert.equal((await page({...query,start:"2024-12-31"})).status,400);
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

test("anonymous Sites views have no shared quota or build lock and reuse the authenticated MCP snapshot",async()=>{
  const {db,connection}=database();
  const origin="https://example.github.io";
  const ownerEmail="owner@example.test";
  const ownerHeaders={"oai-authenticated-user-id":"site-owner","oai-authenticated-user-email":ownerEmail};
  const env={DB:connection(),SNAPSHOT_PUBLIC_ENABLED:"1",SNAPSHOT_PUBLIC_ORIGIN:origin,
    SNAPSHOT_MCP_OWNER_EMAIL:ownerEmail};
  const fundRows=[{date:sessions.at(-1),unit_nav:1.2}];
  const riskFree={rows:[{date:sessions.at(-1),annual_rate:0.01}]};
  const benchmark={official:true,name:"Test benchmark",formula:"100% test index",source:"test issuer",
    source_url:"https://example.com/disclosure"};
  const benchmarkPoints=[{time:sessions.at(-1),value:0.15}];
  const fundPoints=[{time:sessions.at(-1),value:-0.15}];
  const fundRisk={risk_free:riskFree,windows:{"1y":{metrics:{drawdown:{value:-0.15}},
    points:{fund:fundPoints,drawdown:fundPoints,benchmark:benchmarkPoints},
    comparison:{status:"complete",value:0.15,points:benchmarkPoints}}}};
  const association={index_coverage:{price_sources:["index-feed"]},sectors:[]};
  const chart={source:{name:"index-feed"},volume_unit:"手",rows:[{close:100,volume:123}]};
  const fund={status:"complete",data_as_of:fundRows[0].date,source:{name:"fund-feed"},quality:{},
    raw_data:{history:fundRows,fund:{code:"110022",risk_free:riskFree,
      benchmark:{...benchmark,rows:[{date:sessions.at(-1),value:100}],series:[{rows:[{date:sessions.at(-1),value:100}]}]}}},
    models:{risk:fundRisk,sectors:{report:association,charts:{"399997":chart}}},summary:{}};
  const events=[];
  let releaseStock,stockStarted;
  const started=new Promise((resolve)=>{stockStarted=resolve;});
  const pending=new Promise((resolve)=>{releaseStock=resolve;});
  const worker=createSnapshotWorker({calendar,modelVersion:"model-a",clock:()=>new Date(now),observe:(event)=>events.push(event),
    authorize:(request)=>request.headers.has("oai-authenticated-user-id"),
    compute:async(spec,{onUpstream})=>{
      onUpstream({provider:"fixture"});
      if (spec.asset_type==="fund") return fund;
      stockStarted();
      await pending;
      return data;
    }});
  const app=mountSnapshotSite({analysis:worker,legacy:worker});
  const web=(args,bindings=env,options={})=>app.fetch(new Request(
    "https://worker.example/api/analysis?"+new URLSearchParams(args),options),bindings);
  const fundQuery={asset_type:"fund",symbol:"110022"};
  const rpcResponse=(name,args,headers=ownerHeaders)=>{
    return app.fetch(new Request("https://worker.example/mcp",{method:"POST",headers,
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})}),env);
  };
  const rpc=async(name,args)=>{
    const response=await rpcResponse(name,args);
    return (await response.json()).result.structuredContent;
  };
  assert.equal((await web(query,{...env,SNAPSHOT_PUBLIC_ENABLED:"0"})).status,404);
  const {SNAPSHOT_PUBLIC_ENABLED:enabled,...unconfigured}=env;
  assert.equal((await web(query,unconfigured)).status,404);
  assert.equal((await web(query,{...env,SNAPSHOT_MCP_OWNER_EMAIL:""})).status,404);
  assert.equal((await web(query,{...env,DB:null})).status,503);
  assert.equal((await web(query,{...env,SNAPSHOT_PUBLIC_SYMBOLS:"fund:110022"})).status,403);
  const rejected=await web(query,env,{headers:{Origin:"https://other.example"}});
  assert.equal(rejected.status,403);
  assert.equal(rejected.headers.has("Access-Control-Allow-Origin"),false);
  for (const extra of [{refresh:"true"},{after_snapshot_id:"x"},{symbol:"300078,600519"},{end:sessions.at(-2)},
    {snapshot_id:crypto.randomUUID(),category:"history"}]) assert.equal((await web({...query,...extra})).status,400);
  assert.equal((await web([["asset_type","stock"],["symbol","300078"],["symbol","600519"]])).status,400);
  assert.equal((await web({...query,symbol:"0".repeat(520)})).status,414);
  assert.equal((await web(query,env,{method:"POST"})).status,405);
  assert.equal((await rpcResponse("get_stock_analysis",{symbol:query.symbol},{})).status,403);
  assert.equal((await rpcResponse("get_stock_analysis",{symbol:query.symbol},{...ownerHeaders,
    "oai-authenticated-user-email":"visitor@example.test"})).status,403);
  assert.equal((await app.fetch(new Request("https://worker.example/__stage_trace"),env)).status,404);
  assert.equal(events.length,0);

  const cold=web(query);
  await started;
  assert.equal((await web(query)).status,202);
  const fundResponse=await web(fundQuery,env,{headers:{Origin:origin}});
  assert.equal(fundResponse.status,200,"a different symbol may complete while the stock builds");
  releaseStock();
  const stock=await (await cold).json();
  assert.equal(fundResponse.headers.get("Access-Control-Allow-Origin"),origin);
  assert.equal(fundResponse.headers.has("Access-Control-Allow-Credentials"),false);
  const fundSnap=await fundResponse.json();
  for (let i=0;i<61;i++) {
    const res=await web(query);
    assert.equal(res.status,200);
    assert.equal((await res.json()).snapshot_id,stock.snapshot_id);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analysis_snapshot_limits").get().n,0);
  for (const [args,snapshot,expected] of [[query,stock,indicators],[fundQuery,fundSnap,fundRows]]) {
    assert.equal(snapshot.cache,"miss");
    assert.equal(snapshot.summary,undefined);
    const pinned={...args,snapshot_id:snapshot.snapshot_id,category:"page"};
    const read=await (await web(pinned)).json();
    assert.equal(read.snapshot_id,snapshot.snapshot_id);
    assert.deepEqual(args.asset_type==="stock"?read.data.rows:read.data.fund.rows,expected);
    const mcp=await rpc("get_analysis_details",{...pinned,category:"history",limit:1});
    assert.equal(mcp.snapshot_id,snapshot.snapshot_id);
    assert.equal(mcp.model_version,read.model_version);
    assert.deepEqual(mcp.data.rows,args.asset_type==="stock"?rows.slice(-1):fundRows);
    assert.equal((await (await web(args)).json()).snapshot_id,snapshot.snapshot_id);
    assert.match(read.model_version,/model-a/);
  }
  const pinnedFund={...fundQuery,snapshot_id:fundSnap.snapshot_id,category:"page"};
  const publicView=await (await web(pinnedFund)).json();
  assert.deepEqual(publicView.data.association,association);
  assert.equal(publicView.data.fund.risk_free,undefined);
  assert.deepEqual(publicView.data.fund.benchmark,benchmark);
  assert.equal(publicView.data.risk.risk_free,undefined);
  const window=publicView.data.risk.windows["1y"];
  assert.deepEqual(window.points,{fund:fundPoints,drawdown:fundPoints});
  assert.deepEqual(window.comparison,{status:"complete",value:0.15});
  const privateRisk=await rpc("get_analysis_details",{...pinnedFund,category:"risk",period:"1y"});
  assert.deepEqual(privateRisk.data.metrics,window.metrics);
  assert.deepEqual(privateRisk.data.comparison.points,benchmarkPoints);
  const index={...pinnedFund,category:"index",index_code:"399997"};
  assert.deepEqual((await (await web(index)).json()).data,chart);
  const legacy=await (await web(pinnedFund,{...env,SNAPSHOT_PUBLIC_DISPLAY_GRANTS:"fund:other-feed"})).json();
  assert.equal(legacy.snapshot_id,fundSnap.snapshot_id);
  const upgraded=createSnapshotWorker({calendar,modelVersion:"model-b",clock:()=>new Date(now),observe:()=>{}});
  const oldView=await upgraded.fetch(new Request("https://worker.example/api/analysis?"+new URLSearchParams(pinnedFund)),env);
  assert.equal(oldView.status,409);
  assert.equal((await oldView.json()).status,"version_mismatch");
  assert.equal((await web({...pinnedFund,symbol:"003095"})).status,404);
  db.exec("UPDATE analysis_snapshots SET expires_at=0 WHERE asset_type='fund'");
  assert.equal((await web(pinnedFund)).status,410);
  assert.equal((await rpc("get_stock_analysis",{symbol:query.symbol})).snapshot_id,stock.snapshot_id);
  db.exec("UPDATE analysis_snapshot_limits SET calls=30,minute=unixepoch()/60 WHERE slot='owner_details'");
  const limited=await rpc("get_analysis_details",{...query,snapshot_id:stock.snapshot_id,category:"history"});
  assert.equal(limited.status,"rate_limited");
  assert.equal(limited.snapshot_id,undefined);
  assert.equal(events.filter(({event})=>event==="snapshot_upstream").length,2);
  assert.ok(events.filter(({event})=>["snapshot_hit","snapshot_read"].includes(event))
    .every(({upstream_requests})=>upstream_requests===0));
});

test("different closing dates share the fixed preheat and agree on overlapping indicators",async()=>{
  const {connection}=database();
  const computation=[];
  const service=make(async(args)=>{
    computation.push(args);
    const history=rows.filter((row)=>row.date>=args.start&&row.date<=args.end);
    return {...data,data_as_of:history.at(-1).date,raw_data:{...data.raw_data,history},
      indicators:{rows:calculateIndicators(history)}};
  });
  const current=await service.initial(connection(),query);
  const end=sessions.at(-12),start=sessions.at(-21);
  const earlier=await service.initial(connection(),{...query,start,end});
  assert.notEqual(current.snapshot_id,earlier.snapshot_id);
  assert.deepEqual(computation.map(({start})=>start),["2025-01-01","2025-01-01"]);
  const first=await service.details(connection(),detail(current,"indicators",{start,end}));
  const second=await service.details(connection(),detail(earlier,"indicators",{start,end}));
  assert.deepEqual(first.data.rows,second.data.rows);
  assert.ok(Number.isFinite(second.data.rows[0].ADX14));
  assert.ok(Number.isFinite(second.data.rows[0].MACD_hist));
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
