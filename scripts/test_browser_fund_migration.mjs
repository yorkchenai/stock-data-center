import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const origin="https://yorkchenai.github.io/stock-data-center/";
const site=path.resolve(process.env.PAGES_SITE??"work/pages-site");
const output=process.env.FUND_MIGRATION_OUTPUT??"work/browser-funds";
const comparePath=process.env.FUND_MIGRATION_INPUT??"work/browser-fund-parity-input.json";
const codes={"110022":"399997","006751":"000994","003095":"000991"};
const mime={".html":"text/html; charset=utf-8",".mjs":"text/javascript",".js":"text/javascript",".css":"text/css",".json":"application/json"};
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??"/usr/bin/chromium",args:["--no-sandbox"]});
const summary={origin,preview:"PR assets routed only inside this browser; provider requests and CORS are unmodified",funds:{}};
const parity={funds:{}};
async function serveAssets(context) {
  await context.route(origin+"**",async(route)=>{
    const url=new URL(route.request().url());
    const file=path.resolve(site,decodeURIComponent(url.pathname.slice(new URL(origin).pathname.length)));
    if (!file.startsWith(site+path.sep)) return route.abort();
    try {
      let body=await readFile(file);
      if (file===path.join(site,"funds/app.mjs")) body=body+"\nexport {loaded,browserSectors};\n";
      return route.fulfill({contentType:mime[path.extname(file)]??"application/octet-stream",body});
    } catch { return route.fulfill({status:404,body:"Preview file not found"}); }
  });
}
async function selectCode(page,code) {
  if (await page.locator("#fund-detail").isVisible()) await page.locator("#back-to-funds").click();
  await page.locator("#search-term").fill(code);
  await page.locator("#fund-search button").click();
  await page.waitForFunction((code)=>location.search==="?fund="+code,code);
  await page.waitForFunction(()=>document.querySelector("#nav-chart canvas")||document.querySelector("#detail-status").dataset.state==="error",
    null,{timeout:35_000});
  assert.notEqual(await page.locator("#detail-status").getAttribute("data-state"),"error",
    await page.locator("#detail-status").textContent());
}

try {
  const live=await browser.newPage();
  const actual=await live.goto(origin,{waitUntil:"domcontentloaded",timeout:25_000});
  summary.production_page_status=actual.status();
  assert.equal(actual.status(),200);
  await live.close();
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await serveAssets(context);
  const page=await context.newPage();
  const touchSession=await context.newCDPSession(page);
  const pageErrors=[];
  const localRequests=[];
  page.on("pageerror",(error)=>pageErrors.push(error.message));
  page.on("request",(request)=>{if (new URL(request.url()).pathname.startsWith("/api/funds")) localRequests.push(request.url());});
  await page.goto(origin+"funds.html");
  assert.equal(new URL(page.url()).origin,"https://yorkchenai.github.io");
  for (const [code,target] of Object.entries(codes)) {
    await selectCode(page,code);
    await page.waitForFunction(()=>document.querySelector("#sector-tabs button")||
      !document.querySelector("#sector-status").textContent.startsWith("正在识别"),null,{timeout:65_000});
    const result=await page.evaluate(async ({base,code,target})=>{
      const {loaded,browserSectors}=await import(base+"funds/app.mjs");
      const fund=loaded.get(code);
      const context=await browserSectors.analyze(fund);
      const {report,histories,sessions}=context;
      const matched=report.sectors.find((entry)=>entry.code===target);
      return {fund,report,histories,sessions,chart:matched?browserSectors.history(code,matched,context):null};
    },{base:origin,code,target});
    assert.equal(result.fund.code,code);
    assert.ok(result.fund.rows.length>1000);
    assert.ok(["isolated-script","browser-cors"].includes(result.fund.source.transport));
    assert.equal(await page.locator("#core-metrics .metric").count(),6);
    assert.ok(await page.locator("#returns-chart canvas").count());
    assert.ok(await page.locator("#drawdown-chart canvas").count());
    const entry=page.locator(`[data-index="${target}"]`);
    const visibleCount=await page.locator("#sector-tabs button").count();
    assert.equal(visibleCount,result.report.sectors.length,await page.locator("#sector-status").textContent());
    const observed={nav_date:result.fund.rows.at(-1).date,net_value:result.fund.rows.at(-1).unit_nav,
      fund_name:result.fund.name,category:result.fund.category,transport:result.fund.source.transport,
      nav_rows:result.fund.rows.length,coverage:result.report.index_coverage,model_date:result.report.model_as_of,
      ranked:result.report.sectors.map(({code})=>code),sector_status:result.report.status,
      latest_chart:result.chart?.last??null};
    result.visible_metrics=await page.locator("#core-metrics .metric").evaluateAll((items)=>
      Object.fromEntries(items.map((item)=>[item.dataset.metric,item.querySelector("strong").textContent])));
    observed.return_1y=result.visible_metrics.return;
    observed.drawdown_1y=result.visible_metrics.drawdown;
    summary.funds[code]=observed;
    parity.funds[code]=result;
    if (await entry.count()) {
      await entry.click();
      await page.locator('#sector-chart[data-chart-mode="candles"]').waitFor();
      assert.equal(result.chart.volume_unit,"手");
      assert.match(await page.locator("#sector-volume-note").textContent(),/日成交量 · 手/);
      assert.equal(await page.locator("#sector-ma label").count(),4);
      assert.equal(await page.locator("#sector-vol label").count(),3);
      observed.index_source=result.chart.source.id;
      const alternative=page.locator(`#sector-tabs button:not([data-index="${target}"])`).first();
      if (await alternative.count()) {
        const alternate=await alternative.getAttribute("data-index");
        await alternative.click();
        await page.waitForFunction((index)=>document.getElementById("sector-index-title").textContent.endsWith(index),alternate);
        await entry.click();
        await page.waitForFunction((index)=>document.getElementById("sector-index-title").textContent.endsWith(index),target);
        observed.index_switch=true;
      }
    }
    for (const [width,height] of [[1440,1000],[1920,1000],[390,844],[430,932]]) {
      await page.setViewportSize({width,height});
      await touchSession.send("Emulation.setTouchEmulationEnabled",{enabled:width<500,maxTouchPoints:2});
      await page.evaluate(()=>new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      await page.screenshot({path:path.join(output,`fund-${code}-${width}.png`),fullPage:true});
      if (await entry.count() && width===(code==="006751"?430:390)) {
        const chart=page.locator("#sector-chart");
        await chart.scrollIntoViewIfNeeded();
        const box=await chart.boundingBox();
        const x=box.x+box.width*.46,y=box.y+box.height*.42;
        const before=await chart.getAttribute("data-visible-from");
        const pinch=(type,d)=>touchSession.send("Input.dispatchTouchEvent",{type,touchPoints:d?[
          {x:x-d,y,id:1},{x:x+d,y,id:2},
        ]:[]});
        await pinch("touchStart",16);
        for (const distance of [26,36,46,56,66,76]) await pinch("touchMove",distance);
        await pinch("touchEnd",0);
        await page.waitForFunction((before)=>document.getElementById("sector-chart").dataset.visibleFrom!==before,before);
        observed.mobile_pinch=width;
      }
    }
    await page.setViewportSize({width:1440,height:1000});
    await touchSession.send("Emulation.setTouchEmulationEnabled",{enabled:false});
  }
  await page.locator("#back-to-funds").click();
  await page.locator("#search-term").fill("富国互联科技");
  await page.locator("#fund-search button").click();
  await page.getByText(/006751/).first().waitFor();
  assert.deepEqual(pageErrors,[]);
  assert.deepEqual(localRequests,[]);
  summary.python_http_requests=localRequests.length;
  await context.close();

  const outage=await browser.newContext();
  await serveAssets(outage);
  await outage.route("https://fund.eastmoney.com/pingzhongdata/999999.js",(route)=>route.abort());
  const failure=await outage.newPage();
  await failure.goto(origin+"funds.html?fund=999999");
  await failure.locator('#detail-status[data-state="error"]').waitFor({timeout:35_000});
  assert.equal(await failure.locator("#nav-chart canvas").count(),0);
  summary.blocked_provider={status:"error",message:await failure.locator("#detail-status").textContent()};
  await outage.close();
} finally {
  await writeFile(path.join(output,"browser-summary.json"),JSON.stringify(summary,null,2)+"\n");
  await writeFile(comparePath,JSON.stringify(parity));
  await browser.close();
}
