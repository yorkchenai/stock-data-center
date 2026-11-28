// Local Worker, two isolated D1 stores, and desktop/mobile Chromium. Public quotes are explicit fixtures.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, extname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { passwordVerifier } from "../worker/portfolio/auth.mjs";

const require = createRequire(join(process.env.SNAPSHOT_TEST_TOOLS??"/tmp/analysis-snapshot-tools","runner.cjs"));
const { Miniflare }=require("miniflare");
const { build }=require("esbuild");
const root=resolve("worker/portfolio");
const username=randomUUID();
const passphrase=randomBytes(28).toString("base64url");
const adminHash=await passwordVerifier(passphrase);
const clock="2026-11-27T10:00:00.000Z";
const testFund="123456";
const bundle=await build({stdin:{resolveDir:root,contents:`
  import { createPortfolioWorker } from "./worker.mjs";
  const deriveBits=crypto.subtle.deriveBits.bind(crypto.subtle);
  crypto.subtle.deriveBits=(algorithm,...args)=>{
    if(algorithm.name==="PBKDF2" && algorithm.iterations>100_000) {
      throw new DOMException("Pbkdf2 failed: iteration counts above 100000 are not supported", "NotSupportedError");
    }
    return deriveBits(algorithm,...args);
  };
  export default createPortfolioWorker({
    now:()=>new Date(${JSON.stringify(clock)}),
    fundName:async(code)=>code==="654321"?"转入测试基金":null,
    confirmedNav:async(code)=>({source:"隔离测试净值",rows:[{date:"2026-10-10",unit_nav:code==="654321"?12:14}]}),
    market:async()=>({name:"Test fund",source:"test fixture",rows:[
      {date:"2026-09-29",unit_nav:10},{date:"2026-10-11",unit_nav:12}
    ]})
  });
`},format:"esm",bundle:true,platform:"browser",write:false});
const schema=(await readFile(join(root,"migrations/0001_portfolio.sql"),"utf8")).trim()
  .split(/;\s*(?=CREATE\b|$)/).filter(Boolean);

async function open(){
  const mime={".html":"text/html;charset=UTF-8",".css":"text/css",".mjs":"text/javascript"};
  const mf=new Miniflare({modules:true,compatibilityDate:"2026-07-30",script:bundle.outputFiles[0].text,port:0,
    d1Databases:{PORTFOLIO_DB:randomUUID()},bindings:{PORTFOLIO_ADMIN_USER:username,PORTFOLIO_ADMIN_HASH:adminHash},
    serviceBindings:{ASSETS:async(request)=>{
      const path=new URL(request.url).pathname;
      const filename=path==="/"?"index.html":path.slice(1);
      return new Response(await readFile(join(root,"ui",filename)),{headers:{"Content-Type":mime[extname(filename)]}});
    }}});
  try {
    const url=(await mf.ready).origin, db=await mf.getD1Database("PORTFOLIO_DB");
    await db.batch(schema.map((sql)=>db.prepare(sql)));
    return {mf,url,db};
  } catch(error) {await mf.dispose();throw error;}
}

function client({url}){
  let cookie="";
  return async (path,{method="GET",data,sendCookie=true,origin=url,expected=200}={})=>{
    const response=await fetch(url+"/api/"+path,{method,headers:{
      ...(method!=="GET"?{Origin:origin}:{}),
      ...(data===undefined?{}:{"Content-Type":"application/json"}),
      ...(sendCookie&&cookie?{Cookie:cookie}:{}),
    },body:data===undefined?undefined:JSON.stringify(data)});
    assert.equal(response.headers.get("Cache-Control"),"private, no-store");
    const result=await response.json();
    assert.equal(response.status,expected,`${method} ${path} ${JSON.stringify(result.error??"")}`);
    const setCookie=response.headers.get("Set-Cookie");
    if(setCookie){
      assert.match(setCookie,/^__Host-fund-portfolio=[^;]*; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
      cookie=setCookie.split(";")[0];
    }
    return {result,response};
  };
}

const start=await open();
let target,browser;
try {
  const call=client(start);
  for(const path of ["session","ledger","summary","funds/123456","fund-entry/654321","backup"]) await call(path,{expected:401});
  await call("transactions",{method:"POST",data:{},expected:401});
  await call("register",{method:"POST",data:{},expected:401});
  await call("login",{method:"POST",data:{username,password:passphrase},origin:"https://example.test",expected:403});
  await call("login",{method:"POST",data:{username:"other-user",password:passphrase},expected:401});
  await call("login",{method:"POST",data:{username,password:passphrase}});
  assert.equal((await start.db.prepare("SELECT COUNT(*) AS count FROM portfolio_sessions").first()).count,1);
  assert.equal((await call("ledger")).result.records.length,0);
  assert.equal((await call("fund-entry/654321")).result.name,"转入测试基金");
  assert.equal((await call("fund-entry/654321?date=2026-10-09")).result.unit_nav,null);
  assert.equal((await call("fund-entry/654321?date=2026-10-10")).result.unit_nav,"12.000000");
  await call("fund-entry/654321?date=2027-01-01",{expected:400});

  const {result:first}=await call("transactions",{method:"POST",expected:201,data:{
    fund_code:testFund,fund_name:"测试基金",type:"subscription",status:"confirmed",applied_at:"2026-09-30 10:05",
    confirmed_on:"2026-10-01",confirmed_nav:"10.07",confirmed_shares:"100",application_amount:"1005",paid_amount:"1010",fee:"5",
  }});
  const {result:edit}=await call("transactions/"+first.id,{method:"PUT",data:{
    transaction:{...first,notes:"本地修改"},revision:first.revision,
  }});
  assert.equal(edit.revision,2);
  await call("transactions/"+first.id,{method:"PUT",expected:409,data:{transaction:first,revision:first.revision}});
  const {result:deleted}=await call("transactions",{method:"POST",expected:201,data:{
    fund_code:testFund,type:"cash_dividend",status:"pending",confirmed_amount:"20",
  }});
  await call("transactions/"+deleted.id,{method:"DELETE",data:{revision:deleted.revision}});
  const {result:{audit}}=await call("transactions/"+deleted.id+"/audit");
  assert.deepEqual(audit.map((entry)=>entry.action),["create","delete"]);
  assert.equal(audit[1].before.confirmed_amount,"20.00");
  assert.equal(audit[1].after,null);
  const editAudit=(await call("transactions/"+first.id+"/audit")).result.audit;
  assert.equal(editAudit[1].action,"edit");
  assert.equal(editAudit[1].before.notes,null);
  assert.equal(editAudit[1].after.notes,"本地修改");
  assert.equal((await call("summary")).result.totals.holding_cost,null);
  await call("settings/"+testFund,{method:"PUT",data:{history_complete:true}});
  const {result:summary}=await call("summary");
  assert.equal(summary.funds[0].holding_cost,"1010.00");
  assert.equal(summary.funds[0].floating_pnl,"190.00");
  assert.equal(summary.totals.estimated_pnl,null);
  const {result:fund}=await call("funds/"+testFund);
  assert.equal(fund.history[1].unit_nav,12);
  assert.equal(fund.transactions[0].confirmed_nav,"10.070000");

  const {result:backup,response}=await call("backup");
  assert.match(response.headers.get("Content-Disposition"),/^attachment;/);
  assert.equal(backup.transactions.length,2);
  assert.equal(backup.audit.length,4);
  assert.equal(Object.hasOwn(backup,"sessions"),false);
  await call("restore",{method:"POST",data:backup,expected:409});
  target=await open();
  const restored=client(target);
  await restored("login",{method:"POST",data:{username,password:passphrase}});
  const broken=structuredClone(backup);
  broken.transactions[0].confirmed_nav="99";
  await restored("restore",{method:"POST",data:broken,expected:400});
  await restored("restore",{method:"POST",data:backup,expected:201});
  const copy=(await restored("backup")).result;
  assert.deepEqual(copy.transactions,backup.transactions);
  assert.deepEqual(copy.funds,backup.funds);
  assert.deepEqual(copy.audit.slice(0,-1),backup.audit);
  assert.equal(copy.audit.at(-1).action,"restore");
  await restored("restore",{method:"POST",data:backup,expected:409});
  const {result:legacyRedemption}=await call("transactions",{method:"POST",expected:201,data:{
    fund_code:testFund,type:"redemption",status:"confirmed",applied_at:"2026-10-06 14:00",
    confirmed_on:"2026-10-07",received_on:"2026-10-08",confirmed_nav:"12",confirmed_shares:"1",received_amount:"12",fee:"0",
  }});
  await call("logout",{method:"POST"});
  await call("summary",{expected:401});

  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??"/usr/bin/chromium",args:["--no-sandbox"]});
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:844},isMobile:width===390,hasTouch:width===390});
    const page=await context.newPage(), errors=[];
    page.on("pageerror",(error)=>errors.push(error.message));
    await page.goto(start.url);
    await page.locator("#login-panel").waitFor();
    assert.equal(await page.locator("#account").isVisible(),false);
    await page.locator("[name=username]").fill(username);
    await page.locator("[name=password]").fill(passphrase);
    await page.locator("#login button").click();
    await page.locator("#account").waitFor();
    await page.getByRole("button",{name:"测试基金",exact:true}).click();
    await page.locator("#detail").waitFor();
    assert.equal(await page.locator("#fund-title").innerText(),"测试基金 · 123456");
    assert.ok(await page.locator("#cost-chart").evaluate((canvas)=>canvas.width>100));
    if(width===1440){
      await page.locator("#records tbody tr").filter({hasText:"2026-10-06"}).getByRole("button",{name:"查看 / 编辑"}).click();
      assert.equal(await page.locator("[name=applied_at]").inputValue(),"2026-10-06");
      await page.locator("[name=notes]").fill("旧流水补充说明");
      await page.getByRole("button",{name:"保存交易"}).click();
      await page.locator("#editor").waitFor({state:"hidden"});
      const records=await page.evaluate(async()=>(await (await fetch("/api/ledger")).json()).records);
      const edited=records.find((record)=>record.id===legacyRedemption.id);
      assert.equal(edited.notes,"旧流水补充说明");
      assert.equal(edited.confirmed_on,"2026-10-07");
      assert.equal(edited.received_on,"2026-10-08");
    }
    await page.locator("#add").click();
    await page.locator("#editor").waitFor();
    await page.locator("[name=fund_code]").fill("654321");
    await page.waitForFunction(()=>document.querySelector("[name=fund_name]").value==="转入测试基金");
    await page.locator("[name=fund_code]").fill(testFund);
    await page.locator("[name=type]").selectOption("redemption");
    assert.equal(await page.locator("#editor [name=paid_amount], #editor [name=status]").count(),0);
    assert.deepEqual(await page.locator("#entry input[type=date]").evaluateAll((nodes)=>nodes.map((node)=>node.name)),["applied_at"]);
    await page.locator("[name=applied_at]").fill("2026-10-09");
    await page.getByText("申请日暂无净值，请填写平台原值。").waitFor();
    assert.equal(await page.locator("[name=confirmed_nav]").inputValue(),"");
    await page.locator("[name=applied_at]").fill("2026-10-10");
    await page.locator("[name=confirmed_shares]").fill("1");
    await page.locator("[name=fee]").fill("1");
    await page.getByRole("button",{name:"带入此净值"}).click();
    assert.equal(await page.locator("[name=amount]").inputValue(),"13.00");
    await page.locator("[name=amount]").fill("12.99");
    await page.getByRole("button",{name:"保存交易"}).click();
    await page.locator("#editor").waitFor({state:"hidden"});
    await page.waitForFunction(()=>document.querySelector("#records").textContent.includes("12.99 元"));
    if(width===390){
      await page.locator("#add").click();
      await page.locator("[name=type]").selectOption("conversion");
      await page.locator("[name=fund_code]").fill(testFund);
      await page.locator("[name=related_fund_code]").fill("654321");
      await page.waitForFunction(()=>document.querySelector("[name=related_fund_name]").value==="转入测试基金");
      await page.locator("[name=applied_at]").fill("2026-10-10");
      await page.getByRole("button",{name:"带入此净值"}).click();
      await page.getByRole("button",{name:"带入转入净值"}).click();
      assert.equal(await page.locator("[name=confirmed_nav]").inputValue(),"14.000000");
      assert.equal(await page.locator("[name=related_confirmed_nav]").inputValue(),"12.000000");
      await page.locator("[name=confirmed_shares]").fill("2");
      await page.locator("[name=confirmed_nav]").fill("4.25");
      await page.locator("[name=related_confirmed_shares]").fill("1.39");
      await page.locator("[name=related_confirmed_nav]").fill("6.11");
      await page.locator("[name=fee]").fill("0");
      await page.getByRole("button",{name:"保存交易"}).click();
      await page.locator("#editor").waitFor({state:"hidden"});
      await page.waitForFunction(()=>document.querySelector("#records").textContent.includes("转入 转入测试基金"));
      await page.locator("#records tr").filter({hasText:"转入 转入测试基金"}).getByRole("button",{name:"查看 / 编辑"}).click();
      assert.equal(await page.locator("[name=related_confirmed_shares]").inputValue(),"1.390000");
      assert.equal(await page.locator("[name=related_confirmed_nav]").inputValue(),"6.110000");
      await page.locator("#close-editor").click();
      const records=await page.evaluate(async()=>(await (await fetch("/api/ledger")).json()).records);
      const conversion=records.find((record)=>record.type==="conversion");
      assert.equal(conversion.confirmed_on,"2026-10-10");
      const original=records.find((record)=>record.type==="subscription");
      assert.equal(original.confirmed_on,"2026-10-01");
      assert.equal(original.applied_at,"2026-09-30 10:05:00");
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    assert.deepEqual(errors,[]);
    await page.locator("#logout").click();
    await page.locator("#login-panel").waitFor();
    assert.equal(await page.locator("#records tbody tr").count(),0);
    await context.close();
  }

  // Eight attempts total for one window. Account selection never bypasses the shared cap.
  for(let i=0;i<4;i++) await call("login",{method:"POST",data:{username,password:"incorrect"},expected:401});
  const limited=await call("login",{method:"POST",data:{username,password:passphrase},expected:429});
  assert.ok(Number(limited.response.headers.get("Retry-After"))>0);
  await target.db.prepare("UPDATE portfolio_sessions SET expires_at=0").run();
  await restored("summary",{expected:401});
  console.log("PASS: Workerd login with a 100,000-round native PBKDF2 ceiling; sessions, origin and login limits; D1 CRUD and audit; backup restore; 1440px and 390px browser flow");
} finally {
  await browser?.close();
  await target?.mf.dispose();
  await start.mf.dispose();
}
