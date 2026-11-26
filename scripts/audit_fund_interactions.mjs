// Playwright opens the application's real loopback paths and imports the same NAVs
// in an isolated static copy. Only timing and identity checks are emitted.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright-core";

const {origin,fixtures} = JSON.parse(readFileSync(0,"utf8"));
const prefix = "/stock-data-center/";
const web = path.resolve("web");
const mime = {".html":"text/html",".mjs":"text/javascript",".js":"text/javascript",".css":"text/css",".json":"application/json"};
const server = createServer(async (request,response)=>{
  try {
    const pathname = new URL(request.url,"http://localhost").pathname;
    const filename = path.resolve(web,pathname.slice(prefix.length));
    if (!pathname.startsWith(prefix) || !filename.startsWith(web+path.sep)) return response.writeHead(404).end();
    response.writeHead(200,{"Content-Type":mime[path.extname(filename)]}).end(await readFile(filename));
  } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const staticOrigin = "http://127.0.0.1:"+server.address().port+prefix;
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,args:["--no-sandbox"]});
const first = fixtures[0], second = fixtures[1];
const filenames = fixtures.map(fund=>({name:fund.code+".json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(fund))}));
const result = {history_rows:fixtures.map(fund=>fund.rows.length),modes:{}};
try {
  for (const [mode,base] of [["local",origin+"/"],["static",staticOrigin]]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(12_000);
    const historyRequests = [];
    const errors = [];
    page.on("pageerror",e=>errors.push(e.message));
    page.on("request",r=>{
      const route = new URL(r.url()).pathname;
      if (/^\/api\/funds\/\d{6}$/.test(route)) historyRequests.push(route.slice(-6));
    });
    await page.goto(base+"funds.html");
    if (mode==="static") {
      await page.locator("#list-import").setInputFiles(filenames);
    } else {
      for (const item of fixtures) {
        await page.locator("#search-term").fill(item.code);
        await page.getByRole("button",{name:"搜索",exact:true}).click();
        await page.locator("#search-result").getByRole("button",{name:/添加/}).first().click();
        await page.waitForFunction(code=>document.querySelector("#list-status").textContent.includes("已载入 "+code),item.code);
      }
    }
    const elapsed = [];
    for (const fund of [first,second,first]) {
      await page.getByRole("link",{name:fund.name,exact:true}).click();
      assert.match(await page.locator("#fund-identity").innerText(),new RegExp(fund.code));
      assert.equal(await page.locator("#fund-nav-date").innerText(),fund.rows.at(-1).date);
      if (await page.locator("[data-metric='return'] strong").innerText() !== "—") {
        await page.locator("#returns-chart canvas").first().waitFor();
      }
      for (const period of ["1m","3m","6m","1y","3y","5y","all"]) {
        const start = performance.now();
        await page.locator('#fund-periods button[data-period="'+period+'"]').click();
        await page.locator("#core-metrics article").last().waitFor();
        elapsed.push(performance.now()-start);
        assert.equal(await page.locator("#core-metrics article").count(),5);
      }
      await page.getByRole("link",{name:"返回基金列表"}).click();
    }
    assert.equal(errors.length,0);
    assert.deepEqual(historyRequests,mode==="static"?[]:fixtures.map(fund=>fund.code));
    elapsed.sort((a,b)=>a-b);
    result.modes[mode]={pass:true,route_changes:6,range_switches:elapsed.length,
      p50_ms:Math.round(elapsed[Math.floor(elapsed.length*.5)]),
      p95_ms:Math.round(elapsed[Math.floor(elapsed.length*.95)]),
      history_requests:historyRequests.length,additional_history_requests:0};
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
console.log(JSON.stringify(result));
