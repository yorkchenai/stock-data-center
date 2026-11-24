// Isolated workerd + persisted D1, no deployment or production credentials.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { calculateIndicators, FIELDS } from "../web/engine.mjs";

const require=createRequire(pathToFileURL(join(process.env.SNAPSHOT_TEST_TOOLS??"/tmp/analysis-snapshot-tools","runner.cjs")));
const {Miniflare}=require("miniflare");
const {build}=require("esbuild");
const root=resolve(".");
const pages=resolve(process.env.SNAPSHOT_TEST_PAGES??"work/snapshot-stage-pages");
const output=resolve(process.env.SNAPSHOT_TEST_REPORT??"work/snapshot-stage-summary.json");
const sample=process.argv.includes("--fixture");
const storage=await mkdtemp(join(tmpdir(),"snapshot-stage-"));
const origin="http://127.0.0.1:8767", service="http://127.0.0.1:8787";
const symbols=[["stock","300078","sz300078"],["stock","600519","sh600519"],
  ["fund","110022","110022"],["fund","006751","006751"],["fund","003095","003095"]];
const secret=randomUUID();
let coldEvents=[];
const calendar=await readFile(join(pages,"calendar.json"),"utf8");
const fundConfig=await readFile(join(pages,"fund-config.json"),"utf8");
const {analysis_model_version:version}=JSON.parse(await readFile(join(pages,"build-info.json"),"utf8"));
const fixedFixture=`
async function replay(input) {
  const url=new URL(input);
  const navCode=/pingzhongdata\\/(\\d+)/.exec(url.pathname)?.[1];
  const day=calendar.sessions.filter(d=>d<"2026-11-23"&&d>="2021-01-04");
  if (navCode) {
    const rows=day.map((d,i)=>({x:Date.parse(d),y:2+i*.0001+Math.sin(i/8)*.17,unitMoney:""}));
    return new Response("var fS_code="+JSON.stringify(navCode)+'; var fS_name="Isolated fixture"; var Data_netWorthTrend='+JSON.stringify(rows)+";");
  }
  if (url.pathname.endsWith("fundcode_search.js")) {
    return new Response("var r="+JSON.stringify(["110022","006751","003095"].map(c=>[c,"T","Isolated fixture","股票型","T"]))+";");
  }
  if (url.hostname==="www.csindex.com.cn") return new Response(null,{status:403});
  if (url.hostname!=="push2his.eastmoney.com") return new Response(null,{status:503});
  const [market,code]=url.searchParams.get("secid").split(".");
  const rows=day.filter(d=>d.replaceAll("-","")>=url.searchParams.get("beg")&&d.replaceAll("-","")<=url.searchParams.get("end"))
    .map((d,i)=>[d,20+i/100,20+i/100+Math.sin(i/11),22+i/100,18+i/100,100+i,10000+i].join(","));
  return Response.json({data:{code,market:Number(market),name:"Isolated fixture",klines:rows}});
}
`;
const source=`
import { createSnapshotWorker } from ${JSON.stringify(join(root,"worker/snapshots/worker.mjs"))};
import { createSnapshotCompute } from ${JSON.stringify(join(root,"worker/snapshots/compute.mjs"))};
const calendar=${calendar}, config=${fundConfig}, modelVersion=${JSON.stringify(version)};
${sample?fixedFixture:""}
const events=[];
const trace=(event)=>{
  if(events.length<1000) events.push(event);
  console.log(JSON.stringify(event));
};
const auth=(request,env)=>request.headers.get("Authorization")==="Bearer "+env.TEST_SECRET;
const worker=createSnapshotWorker({calendar,config,modelVersion,observe:trace,
  ${sample?'compute:createSnapshotCompute({calendar,config,fetcher:replay,observe:(event)=>trace({event:"snapshot_upstream",...event})}),':''}
  authorize:auth});
export default {fetch(request,env,ctx) {
  if(auth(request,env) && new URL(request.url).pathname==="/__stage_trace") return Response.json(events);
  return worker.fetch(request,env,ctx);
}};
`;
const bundle=await build({stdin:{contents:source,resolveDir:root},bundle:true,format:"esm",
  platform:"browser",target:"es2022",write:false});
const scriptPath=join(storage,"worker.mjs");
await writeFile(scriptPath,bundle.outputFiles[0].text);
const opts={modules:true,modulesRoot:storage,scriptPath,cf:false,host:"127.0.0.1",port:8787,compatibilityDate:"2026-07-30",
  d1Databases:["DB"],d1Persist:join(storage,"d1"),
  bindings:{TEST_SECRET:secret,SNAPSHOT_PUBLIC_ORIGIN:origin,
    SNAPSHOT_PUBLIC_SYMBOLS:symbols.map(([type,,code])=>type+":"+code).join(",")}};
const make=()=>new Miniflare(opts);
let mf=make();
const db=await mf.getD1Database("DB");
const sql=await readFile("worker/snapshots/migrations/0001_analysis_snapshots.sql","utf8");
await db.batch(sql.split(";").map((statement)=>statement.trim()).filter(Boolean).map((statement)=>db.prepare(statement)));
const startServer=createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,origin).pathname;
    const file=resolve(pages,"."+path);
    if (!file.startsWith(pages+"/")) {res.writeHead(404).end();return;}
    const mime={".html":"text/html",".mjs":"text/javascript",".js":"text/javascript",".json":"application/json",".css":"text/css"};
    res.setHeader("Content-Type",mime[extname(file)]??"application/json");
    res.end(await readFile(file));
  } catch {res.writeHead(404).end();}
});
await new Promise((done)=>startServer.listen(8767,"127.0.0.1",done));
const results=[];
let browser;

const wait=(ms)=>new Promise((done)=>setTimeout(done,ms));
async function traces() {
  const response=await fetch(service+"/__stage_trace",{headers:{Authorization:"Bearer "+secret},
    signal:AbortSignal.timeout(5_000)});
  assert.equal(response.status,200);
  return response.json();
}
async function rpc(name,args) {
  const response=await fetch(service+"/mcp",{method:"POST",headers:{Authorization:"Bearer "+secret,"Content-Type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}),
    signal:AbortSignal.timeout(13_000)});
  const packet=await response.json();
  assert.ok(packet.result?.structuredContent,JSON.stringify(packet.error??{status:response.status}));
  return packet.result.structuredContent;
}
async function initial(type,symbol) {
  const began=performance.now();
  const elapsed=(value)=>Math.round(performance.now()-value);
  const tool=type==="stock"?"get_stock_analysis":"get_fund_analysis";
  let result=await rpc(tool,{symbol});
  const first_ms=elapsed(began);
  const first_status=result.status;
  for (let tries=0;result.status==="building"&&tries<9;tries++) {
    await wait(3_200);
    // Observe progress via page GET so repeated polling can use the separate
    // page quota, while first and subsequent speech use actual MCP JSON-RPC.
    const url=service+"/api/analysis?"+new URLSearchParams({asset_type:type,symbol});
    const rs=await fetch(url,{headers:{Origin:origin},signal:AbortSignal.timeout(13_000)});
    result=await rs.json();
  }
  return {first_status,first_ms,ready_ms:elapsed(began),result};
}
async function pageSnapshot(type,symbol,snapshot_id) {
  const params=new URLSearchParams({asset_type:type,symbol,snapshot_id,category:"page"});
  const response=await fetch(service+"/api/analysis?"+params,{headers:{Origin:origin}});
  assert.equal(response.headers.get("Access-Control-Allow-Origin"),origin);
  return response.json();
}
async function latestSnapshot(type,symbol) {
  const params=new URLSearchParams({asset_type:type,symbol});
  return fetch(service+"/api/analysis?"+params,{headers:{Origin:origin}}).then((response)=>response.json());
}
const report=()=>({sample:sample?"deterministic fixture":"live vendor",stage:"local workerd + persisted D1",
  model_version:version,results,
  upstream:coldEvents.filter((event)=>event.event==="snapshot_upstream"),
  storage:coldEvents.filter((event)=>event.event==="snapshot_publish")});
try {
  for (const [type,symbol] of symbols) {
    try {
      const {result,...elapsed}=await initial(type,symbol);
      results.push({type,symbol,...elapsed,initial_status:result.status,
        ...(result.snapshot_id ? {snapshot_id:result.snapshot_id,data_as_of:result.data_as_of,
          index_coverage:result.index_coverage} : {error:result.message})});
    } catch (error) {results.push({type,symbol,error:error.message});}
  }
  coldEvents=await traces();
  await mf.dispose();
  mf=make();
  await mf.ready;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||"/usr/bin/chromium",
    args:["--no-sandbox"],headless:true});
  for (const row of results.filter((r)=>r.snapshot_id)) {
    try {
      const {type,symbol,snapshot_id}=row;
      const args={asset_type:type,symbol,snapshot_id};
      const lookupStarted=performance.now();
      const cached=await latestSnapshot(type,symbol);
      row.hit_ms=Math.round(performance.now()-lookupStarted);
      assert.equal(cached.cache,"hit");
      assert.equal(cached.snapshot_id,snapshot_id);
      const snapshot=await pageSnapshot(type,symbol,snapshot_id);
      assert.equal(snapshot.model_version,version);
      assert.equal(snapshot.snapshot_id,snapshot_id);
      const isStock=type==="stock";
      const stored=isStock?snapshot.data.rows:snapshot.data.fund.rows;
      const field=isStock?"high":"unit_nav";
      const checks=[
        {category:"history",date:row.data_as_of},
        {category:"history",limit:20},
        {category:"history",limit:20,aggregate:"max",field},
        {category:isStock?"indicators":"risk",limit:1},
        {category:isStock?"model":"sectors"},
      ];
      row.detail_ms=[];
      for (const [i,query] of checks.entries()) {
        const started=performance.now();
        const value=await rpc("get_analysis_details",{...args,...query});
        row.detail_ms.push(Math.round(performance.now()-started));
        assert.equal(value.snapshot_id,snapshot_id);
        assert.equal(value.model_version,version);
        if (i===0) assert.equal(value.data.rows.at(-1)[field],stored.at(-1)[field]);
        if (i===1) assert.deepEqual(value.data.rows.map(r=>r.date),stored.slice(-20).map(r=>r.date));
        if (i===2) assert.equal(value.data.extreme.value,Math.max(...stored.slice(-20).map(r=>r[field])));
        if (i===3 && isStock) {
          for (const name of ["MA5","MACD_hist","RSI14","ADX14","VOL5"]) {
            assert.equal(value.data.rows[0][name],stored.at(-1)[name]);
          }
          const input=stored.map((r)=>Object.fromEntries(FIELDS.map((key)=>[key,r[key]])));
          assert.deepEqual(stored,calculateIndicators(input));
        }
        if (i===3 && !isStock) assert.deepEqual(value.data.metrics,snapshot.data.risk.windows["1y"].metrics);
        if (i===4 && !isStock) assert.deepEqual(value.data?.sectors??[],snapshot.data.association?.sectors??[]);
      }
      const page=await browser.newPage();
      try {
        const requestFailures=[];
        page.on("pageerror",(error)=>requestFailures.push(error.message));
        const url=isStock?"/index.html?symbol="+symbol:"/funds.html?fund="+symbol;
        const pageResponse=page.waitForResponse((response)=>response.url().includes("category=page"));
        const firstSector=snapshot.data.association?.sectors[0];
        const indexResponse=firstSector? page.waitForResponse((response)=>response.url().includes("category=index")):null;
        await page.goto(origin+url+"&snapshot_id="+snapshot_id);
        const view=await (await pageResponse).json();
        assert.deepEqual(view,snapshot);
        await page.waitForFunction(({selector,id})=>document.querySelector(selector)?.textContent.includes(id),
          {selector:isStock?"#status":"#fund-source",id:snapshot_id},{timeout:8_000});
        if (indexResponse) {
          const index=await (await indexResponse).json();
          const model=await rpc("get_analysis_details",{...args,category:"sectors",index_code:firstSector.code,limit:1});
          assert.equal(index.snapshot_id,snapshot_id);
          assert.equal(index.data.last,model.data.chart.last_index_trade_date);
          assert.deepEqual(index.data.rows.slice(-1),model.data.chart.rows);
          row.sector_index={code:firstSector.code,last:index.data.last};
        }
        assert.deepEqual(requestFailures,[]);
      } finally {await page.close();}
      row.browser_mcp_identical=true;
      row.rows=stored.length;
      row.sector_status=snapshot.data.association?.status;
      row.rank_codes=snapshot.data.association?.sectors.map((sector)=>sector.code);
    } catch (error) {row.error=error.message;}
  }
  await wait(250);
  const after=(await traces()).filter((event)=>event.event==="snapshot_upstream").length;
  const summary={...report(),detail_upstream_requests:after};
  await mkdir(resolve(output,".."),{recursive:true});
  await writeFile(output,JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
  assert.equal(after,0,"detail reads must not request vendors");
  assert.ok(results.every(({browser_mcp_identical})=>browser_mcp_identical),"one or more instruments did not pass");
} finally {
  if (browser) await browser.close();
  await mf.dispose();
  await new Promise((done)=>startServer.close(done));
  await rm(storage,{recursive:true,force:true});
}
