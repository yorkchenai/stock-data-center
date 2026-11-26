// Check the actual deployed assets and services, using a normal browser clock.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = new URL((process.env.PAGES_URL || "https://yorkchenai.github.io/stock-data-center").replace(/\/$/,"")+"/");
const worker = new URL(process.env.SNAPSHOT_SERVICE);
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,args:["--no-sandbox"]});
const page = await browser.newPage();
const labels = {fundgz:"估值1",sina_ds2:"估值2",sina_ds3:"估值3"};
const estimateRequests = [];
const historyRequests = [];
const pageErrors = [];
page.on("pageerror",(error)=>pageErrors.push(error.message));
await page.route("https://fundcomapi.tiantianfunds.com/**",(route)=>route.abort());
await page.route("https://stock.finance.sina.com.cn/**",(route)=>route.abort());
function estimateQuery(request) {
  const url = new URL(request.url());
  if (url.origin===worker.origin && url.pathname==="/api/fund-valuation" && url.searchParams.get("provider")==="eastmoney") {
    return url.searchParams.get("symbol");
  }
}
page.on("request",(request)=>{
  const url = new URL(request.url());
  const code = estimateQuery(request);
  if (code) estimateRequests.push({code,time:Date.now()});
  if ((url.origin===worker.origin && url.pathname==="/api/analysis") ||
      (url.hostname==="fund.eastmoney.com" && /\/pingzhongdata\//.test(url.pathname))) historyRequests.push(url.href);
});

async function fund(code) {
  const url = new URL("funds.html",base);
  url.searchParams.set("fund",code);
  url.searchParams.set("release",process.env.GITHUB_RUN_ID || "smoke");
  const response = await page.goto(url.href);
  assert.equal(response.status(),200);
  await page.locator("#nav-chart canvas").first().waitFor({timeout:40_000});
  await page.locator("#returns-chart canvas").first().waitFor({timeout:15_000});
  await page.locator("#drawdown-chart canvas").first().waitFor({timeout:15_000});
  assert.match(await page.locator("#fund-nav").innerText(),/^\d+\.\d+$/);
  assert.equal(await page.locator("#core-metrics article").count(),5);
  assert.match(await page.locator("#risk-reference-note").innerText(),/2\.5%.*252/);
  assert.equal(await page.getByText("超额收益",{exact:true}).count(),0);
  assert.equal(await page.getByRole("heading",{name:"强关联板块指数分析",exact:true}).count(),0);
}

async function quotes(code) {
  const cards = page.locator("#valuation-quotes article");
  try {
    await cards.first().waitFor({timeout:28_000});
  } catch (error) {
    throw new Error(`基金 ${code} 盘中估值未取得 · ${await page.locator("#valuation-status").innerText()}`,{cause:error});
  }
  await page.locator("#valuation-refresh:enabled").waitFor({timeout:16_000});
  const results = await cards.evaluateAll((items)=>items.map((item)=>({
    id:item.dataset.valuationSource,fields:Array.from(item.children,(child)=>child.textContent),
  })));
  for (const {id,fields} of results) {
    assert.equal(fields.length,2);
    assert.ok(Object.hasOwn(labels,id));
    assert.equal(fields[0],labels[id]);
    assert.match(fields[1],/^[+-]?\d+\.\d{2}%$/);
  }
  return results.map(({fields})=>fields.join(" "));
}

async function waitForEstimateRequest(code, timeout) {
  return page.waitForRequest((request)=>estimateQuery(request)===code,{timeout});
}

async function fundAnalysis() {
  return page.locator("#fund-nav, #fund-nav-date, #core-metrics, #risk-metrics").allTextContents();
}

try {
  const estimates = {};
  for (const code of ["019830","014194","018993"]) {
    await fund(code);
    estimates[code] = await quotes(code);
  }

  await fund("003095");
  await page.getByText("历史基准披露",{exact:true}).click();
  assert.match(await page.locator("#benchmark-disclosure").innerText(),/90%.*10%/);
  assert.match(await page.locator("#benchmark-history-list").innerText(),/65%.*35%/);
  const disclosure = await page.locator("#benchmark-source [data-date-kind=published]").innerText();
  const effective = await page.locator("#benchmark-source [data-date-kind=effective]").innerText();
  assert.equal(disclosure,"2026-10-27");
  assert.equal(effective,"2026-09-21");
  assert.equal(await page.locator("#benchmark-history-list [data-date-kind=published]").innerText(),"2026-10-27");

  const code = "110022";
  await fund(code);
  estimates[code] = await quotes(code);
  const before = await fundAnalysis();
  const historyCount = historyRequests.length;
  const first = estimateRequests.filter((item)=>item.code===code).at(-1);
  assert.ok(first);
  await waitForEstimateRequest(code,75_000);
  const elapsed = estimateRequests.filter((item)=>item.code===code).at(-1).time-first.time;
  assert.ok(elapsed>=59_000 && elapsed<=75_000, `自动刷新间隔 ${elapsed}ms`);
  await page.locator("#valuation-refresh:enabled").waitFor({timeout:28_000});
  await quotes(code);

  const manual = waitForEstimateRequest(code,10_000);
  await page.getByRole("button",{name:"刷新估值"}).click();
  await manual;
  await page.locator("#valuation-refresh:enabled").waitFor({timeout:28_000});
  await quotes(code);
  assert.equal(historyRequests.length,historyCount);
  assert.deepEqual(await fundAnalysis(),before);

  await page.locator("#back-to-funds").click();
  const table = page.locator("#fund-table");
  const headings = await table.locator("th").allTextContents();
  const navColumn = headings.indexOf("最新单位净值");
  assert.deepEqual(headings.slice(navColumn-3,navColumn),["估值1","估值2","估值3"]);
  const row = table.locator('tr[data-fund-code="019830"]');
  await row.locator("td[data-estimate]").filter({hasText:/^[+-]?\d+\.\d{2}%$/}).first().waitFor({timeout:20_000});
  const listEstimates = await row.locator("td[data-estimate]").allTextContents();
  assert.equal(historyRequests.length,historyCount);
  assert.deepEqual(pageErrors,[]);

  const anonymous = await fetch(new URL("/mcp",worker),{method:"POST",headers:{
    "Content-Type":"application/json",Accept:"application/json, text/event-stream",
  },body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"}),signal:AbortSignal.timeout(12_000)});
  assert.ok([401,403].includes(anonymous.status),`MCP 匿名请求返回 ${anonymous.status}`);

  console.log(JSON.stringify({url:page.url(),estimates,
    benchmark:{code:"003095",disclosed_on:disclosure,effective_from:effective,historical:true},
    list_019830_estimates:listEstimates,
    browser_direct_estimates_blocked:true,auto_refresh_ms:elapsed,manual_refresh:true,
    history_requests_during_refresh:0,anonymous_mcp:anonymous.status},null,2));
} finally {
  await browser.close();
}
