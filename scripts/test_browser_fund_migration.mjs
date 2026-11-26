import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const origin="https://yorkchenai.github.io/stock-data-center/";
const site=path.resolve(process.env.PAGES_SITE??"work/pages-site");
const output=process.env.FUND_MIGRATION_OUTPUT??"work/browser-funds";
const codes={
  "014194":["95%","5%"],
  "018993":["65%","15%","20%"],
  "110022":["85%","15%"],
};
const mime={".html":"text/html; charset=utf-8",".mjs":"text/javascript",".js":"text/javascript",".css":"text/css",".json":"application/json"};
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??"/usr/bin/chromium",args:["--no-sandbox"]});
const summary={origin,preview:"PR assets routed only inside this browser; provider requests and CORS are unmodified",funds:{}};
async function serveAssets(context) {
  await context.route(origin+"**",async(route)=>{
    const url=new URL(route.request().url());
    const file=path.resolve(site,decodeURIComponent(url.pathname.slice(new URL(origin).pathname.length)));
    if (!file.startsWith(site+path.sep)) return route.abort();
    try {
      let body=await readFile(file);
      if (file===path.join(site,"funds/app.mjs")) body=body+"\nexport {loaded};\n";
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
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await serveAssets(context);
  const page=await context.newPage();
  const pageErrors=[];
  const unexpectedRequests=[];
  page.on("pageerror",(error)=>pageErrors.push(error.message));
  page.on("request",(request)=>{
    const url=new URL(request.url());
    if ((url.origin===new URL(origin).origin && !url.pathname.startsWith("/api/funds/")) ||
        (url.hostname==="fund.eastmoney.com" && /^\/(?:pingzhongdata\/\d{6}\.js|js\/fundcode_search\.js)$/.test(url.pathname))) return;
    if ((url.hostname==="fundcomapi.tiantianfunds.com" && url.pathname==="/mm/newCore/FundValuationLast") ||
        (url.hostname==="stock.finance.sina.com.cn" && url.pathname.endsWith("/FdFundService.getEstimateNetworthPic"))) return;
    if (url.protocol==="https:" || url.protocol==="http:") unexpectedRequests.push(url.href);
  });
  await page.goto(origin+"funds.html");
  assert.equal(new URL(page.url()).origin,"https://yorkchenai.github.io");
  await selectCode(page,"019830");
  await page.locator("#valuation-refresh:enabled").waitFor({timeout:27_000});
  summary.funds["019830"] = {
    valuations:await page.locator("#valuation-quotes article").allInnerTexts(),
    valuation_status:await page.locator("#valuation-status").textContent(),
  };
  for (const [code,weights] of Object.entries(codes)) {
    await selectCode(page,code);
    const fund=await page.evaluate(async ({base,code})=>{
      const {loaded}=await import(base+"funds/app.mjs");
      const {name,rows,source}=loaded.get(code);
      return {name,date:rows.at(-1).date,unit_nav:rows.at(-1).unit_nav,transport:source.transport};
    },{base:origin,code});
    assert.ok(["isolated-script","browser-cors"].includes(fund.transport));
    await page.locator("#benchmark-source a").first().waitFor();
    const benchmark=await page.locator("#benchmark-disclosure").innerText();
    assert.deepEqual(benchmark.match(/\d+%/g),weights);
    assert.equal(await page.locator("#tracking-index").isVisible(),code==="014194");
    assert.equal(await page.getByRole("heading",{name:"强关联板块指数分析"}).count(),0);
    assert.equal(await page.locator("#core-metrics .metric").count(),5);
    assert.ok(await page.locator("#returns-chart canvas").count());
    assert.ok(await page.locator("#drawdown-chart canvas").count());
    await page.locator("#valuation-refresh:enabled").waitFor({timeout:27_000});
    const valuations=await page.locator("#valuation-quotes article").allTextContents();
    summary.funds[code]={...fund,benchmark,valuations,
      valuation_status:await page.locator("#valuation-status").textContent(),
      effective_from:await page.locator("#benchmark-source [data-date-kind=effective]").innerText(),
      source:await page.locator("#benchmark-source a").last().getAttribute("href")};
    for (const [width,height] of [[1440,1000],[390,844]]) {
      await page.setViewportSize({width,height});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      await page.screenshot({path:path.join(output,`fund-${code}-${width}.png`),fullPage:true});
    }
    await page.setViewportSize({width:1440,height:1000});
  }
  assert.deepEqual(pageErrors,[]);
  assert.deepEqual(unexpectedRequests,[]);
  summary.unexpected_requests=unexpectedRequests.length;
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
  await browser.close();
}
