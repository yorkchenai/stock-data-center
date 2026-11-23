// Layout and interaction checks use explicitly labeled synthetic fund histories.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const site = path.resolve(process.env.PAGES_SITE || "work/pages-site");
const output = path.resolve(process.env.BROWSER_OUTPUT || "work/pages-browser");
const prefix = "/stock-data-center/";
const mime = {".html":"text/html",".mjs":"text/javascript",".js":"text/javascript",".css":"text/css",".json":"application/json"};
await mkdir(output,{recursive:true});
const server = createServer(async (request,response)=>{
  try {
    const location = new URL(request.url,"http://localhost").pathname;
    if (!location.startsWith(prefix)) return response.writeHead(404).end();
    const file = path.resolve(site,location.slice(prefix.length) || "index.html");
    if (!file.startsWith(site+path.sep)) return response.writeHead(403).end();
    const data = await readFile(file);
    response.writeHead(200,{"Content-Type":mime[path.extname(file)] ?? "application/json"}).end(data);
  } catch {response.writeHead(404).end();}
});
await new Promise((resolve)=>server.listen(0,"127.0.0.1",resolve));
const origin = `http://127.0.0.1:${server.address().port}${prefix}`;
const browser = await chromium.launch({
  executablePath:process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless:true,args:["--no-sandbox"],
});

function synthetic(code, name, category, start, withBenchmark) {
  const end = "2026-11-20";
  const dates=[];
  for (let ms=Date.parse(start);ms<=Date.parse(end);ms+=86_400_000) {
    const date=new Date(ms);
    if (date.getUTCDay()!==0 && date.getUTCDay()!==6) dates.push(date.toISOString().slice(0,10));
  }
  const payload={
    schema_version:1,kind:"off_market_fund",synthetic:true,code,name,category,
    inception:start,manager:"合成样本管理人",valuation_frequency:"daily",return_basis:"adjusted_nav",
    source:{name:"合成界面测试",method:"独立生成的测试总回报",retrieved_at:"2026-11-20T11:00:00Z"},
    rows:dates.map((date,i)=>{
      const value = 1 + i*.00045 + Math.sin(i/13)*.03 + Math.sin(i/73)*.075;
      return {date,unit_nav:value,accumulated_nav:value+.2,return_index:value,cash_distribution:0,split_factor:1};
    }),
  };
  if (withBenchmark) {
    payload.benchmark={official:true,name:"合成比较基准",source:"界面测试",rows:dates.map((date,i)=>({date,value:1+i*.00026+Math.sin(i/34)*.023}))};
    payload.risk_free={source:"手算测试假设",annual_rate:.02,effective_from:start,effective_to:end};
    payload.holdings={source:"合成披露数据",period_end:"2026-09-30",disclosed_at:"2026-10-20",allocation:"股票 70% · 债券 20% · 现金 10%"};
  }
  return payload;
}
const first = synthetic("000001","合成测试 · 混合基金（A 类份额）","mixed","2020-01-02",true);
const second = synthetic("000002","合成测试 · 短历史债券","bond","2026-03-02",false);
const files = [first,second].map((fixture)=>({name:fixture.code+".json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(fixture))}));
const report = {mode:"explicitly labeled synthetic fund test",viewports:[]};
try {
  for (const [width,height,mobile] of [[1440,900,false],[390,844,true]]) {
    const context = await browser.newContext({viewport:{width,height},isMobile:mobile,hasTouch:mobile});
    const page = await context.newPage();
    const errors=[];
    page.on("pageerror",(error)=>errors.push(error.message));
    await page.goto(origin+"funds.html");
    await page.locator("#list-import").setInputFiles(files);
    await page.getByRole("link",{name:first.name}).waitFor();
    await page.getByRole("link",{name:second.name}).waitFor();
    const tbody = page.locator("#fund-table tbody");
    const long = tbody.locator("tr",{hasText:first.name});
    const short = tbody.locator("tr",{hasText:second.name});
    assert.equal(await long.locator("td").nth(10).textContent() === "—",false);
    assert.equal(await short.locator("td").nth(10).textContent(),"—");
    await page.locator("#search-term").fill("000001");
    await page.getByRole("button",{name:"搜索",exact:true}).click();
    assert.match(await page.locator("#search-result").innerText(),/已添加/);
    await page.locator("#search-term").fill("短历史债券");
    await page.getByRole("button",{name:"搜索",exact:true}).click();
    assert.match(await page.locator("#search-result").innerText(),/000002/);
    const dimensions=await page.locator(".fund-table-scroll").evaluate((target)=>{
      const cell=target.querySelector("tbody td");
      const before=cell.getBoundingClientRect().left;
      target.scrollLeft=360;
      return {width:target.clientWidth,total:target.scrollWidth,delta:cell.getBoundingClientRect().left-before,
        sticky:getComputedStyle(target.querySelector("th")).position};
    });
    assert.ok(dimensions.total > dimensions.width || !mobile);
    assert.ok(Math.abs(dimensions.delta)<2);
    assert.equal(dimensions.sticky,"sticky");
    await page.locator(".fund-table-scroll").evaluate((el)=>{el.scrollLeft=0;});
    await long.getByRole("button",{name:"加入自选 000001"}).click();
    await page.getByRole("button",{name:"自选基金"}).click();
    assert.equal(await tbody.locator("tr").count(),1);
    await page.getByRole("button",{name:"全部基金"}).click();
    await page.locator("#type-filter").selectOption("bond");
    assert.match(await tbody.innerText(),/短历史债券/);
    assert.ok(!(await tbody.innerText()).includes("A 类份额"));
    await page.locator("#type-filter").selectOption("");
    await page.getByRole("button",{name:"近5年",exact:true}).click();
    assert.equal(await page.locator("th[aria-sort]").getAttribute("aria-sort"),"descending");
    await page.getByText("列设置",{exact:true}).click();
    await page.locator("#column-options").getByText("来源",{exact:true}).click();
    assert.equal(await page.getByRole("columnheader",{name:"来源"}).count(),0);
    await page.getByText("列设置",{exact:true}).click();
    await page.screenshot({path:path.join(output,`funds-list-${width}.png`),fullPage:true});
    await page.getByRole("link",{name:first.name}).click();
    await page.locator("#returns-chart canvas").first().waitFor();
    assert.ok(page.url().endsWith("/funds.html?fund=000001"));
    assert.equal(await page.locator("#core-metrics article").count(),6);
    const grid = await page.locator("#core-metrics").evaluate((el)=>getComputedStyle(el).gridTemplateColumns.split(" ").length);
    assert.equal(grid,mobile ? 2 : 3);
    const nav = await page.locator("#fund-nav").innerText();
    const value = page.locator("[data-metric='return'] strong");
    const initial = await value.innerText();
    await page.getByRole("button",{name:"近3年",exact:true}).click();
    assert.notEqual(initial,await value.innerText());
    assert.equal(await page.locator("#fund-nav").innerText(),nav);
    const stats = await page.locator("#core-metrics").innerText();
    if (!mobile) {
      const bound=await page.locator("#returns-chart").boundingBox();
      await page.mouse.move(bound.x+bound.width/2,bound.y+100);
      await page.mouse.wheel(0,-300);
      await page.mouse.move(bound.x+bound.width/2,bound.y+100);
      assert.equal(await page.locator("#core-metrics").innerText(),stats);
    }
    await page.locator("#benchmark-line").uncheck();
    await page.locator("#benchmark-line").check();
    await page.getByRole("button",{name:"自定义",exact:true}).click();
    await page.locator("#fund-start").fill("2026-09-01");
    await page.locator("#fund-end").fill("2026-10-20");
    await page.getByRole("button",{name:"应用区间"}).click();
    assert.match(await page.locator("#range-status").innerText(),/2026-09-01 至 2026-10-20/);
    await page.locator("#fund-start").fill("2026-11-01");
    await page.getByRole("button",{name:"应用区间"}).click();
    assert.match(await page.locator("#range-status").innerText(),/开始日期不能晚于结束日期/);
    assert.equal(await value.innerText(),"—");
    await page.getByRole("button",{name:"近1年",exact:true}).click();
    assert.equal(await value.innerText(),initial);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
    await page.screenshot({path:path.join(output,`funds-detail-${width}.png`),fullPage:true});
    await page.getByRole("link",{name:"返回基金列表"}).click();
    await page.getByRole("link",{name:second.name}).click();
    assert.equal(await page.locator("[data-metric='sharpe'] strong").innerText(),"—");
    assert.equal(await page.locator("[data-metric='excess'] strong").innerText(),"—");
    assert.match(await page.locator("#holdings-data").innerText(),/暂无/);
    await page.getByRole("link",{name:"返回基金列表"}).click();
    await page.reload();
    await page.getByRole("link",{name:first.name}).waitFor();
    assert.equal(await page.getByRole("columnheader",{name:"来源"}).count(),0);
    assert.equal(await page.getByRole("button",{name:"取消自选 000001"}).count(),1);
    await page.getByRole("link",{name:"场内 ETF"}).click();
    assert.match(await page.locator("main").innerText(),/尚未接入/);
    assert.deepEqual(errors,[]);
    await context.close();
    report.viewports.push({width,height,pass:true});
  }
} finally {
  await browser.close();
  await new Promise((resolve)=>server.close(resolve));
}
await writeFile(path.join(output,"funds-browser-report.json"),JSON.stringify(report,null,2)+"\n");
console.log("Fund Pages desktop and mobile checks passed");
