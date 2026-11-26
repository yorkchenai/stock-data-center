// Layout and interaction checks use explicitly labeled synthetic fund histories.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { normalizeFund } from "../web/funds/data.mjs";
import { analyzePerformance, periodStart, selectWindow } from "../web/funds/performance.mjs";

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
    payload.benchmark={official:true,name:"合成比较基准",source:"界面测试",
      regimes:[{source:"界面测试",method:"single_index",effective_from:start,
        components:[{id:"SYN",basis:"price",weight:1}]}],
      series:[{id:"SYN",source:"界面测试",basis:"price",
        rows:dates.slice(0,-1).map((date,i)=>({date,value:1+i*.00026+Math.sin(i/34)*.023}))}]};
    payload.risk_free={name:"合成三个月利率",source:"界面测试",convention:"simple_act_365f",
      effective_from:start,effective_to:end,max_age_days:3,
      rows:dates.map((date,i)=>({date,annual_rate:.01+.001*Math.sin(i/35)}))};
    payload.holdings={source:"合成披露数据",period_end:"2026-09-30",disclosed_at:"2026-10-20",allocation:"股票 70% · 债券 20% · 现金 10%"};
  }
  return payload;
}
const first = synthetic("000001","合成测试 · 混合基金（A 类份额）","mixed","2020-01-02",true);
const second = synthetic("000002","合成测试 · 短历史债券","bond","2026-03-02",false);
const files = [first,second].map((fixture)=>({name:fixture.code+".json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(fixture))}));
function fixtureBundle() {
  const end=first.rows.at(-1).date;
  const market=[["399997","合成指数甲"],["932139","合成指数乙"]];
  const sectors=market.map(([code,name],i)=>({code,name,rank:i+1,quality:"strong",beta:.4,stability:1,
    holdings:{status:i?"conflict":"unverified"},index_as_of:end,
    windows:Object.fromEntries([60,120].map((n)=>[n,{count:n,partial_count:n,pearson:.8,partial:.7}]))}));
  return {schema_version:1,kind:"fund_chart_bundle",fund:first,analysis:{
    schema_version:1,kind:"fund_sector_analysis",fund_code:first.code,computed_at:"2026-11-20T12:00:00Z",
    fund_as_of:end,model_as_of:end,sectors,
  },indices:sectors.map(({code,name},i)=>({
    schema_version:1,kind:"fund_sector_history",fund_code:first.code,code,name,
    model_as_of:end,first:first.rows[0].date,last:end,currency:"CNY",basis:"price",volume_unit:i?null:"手",
    source:{url:"https://example.test/fixture",name:"合成测试"},
    quality:{internal_gaps:0},rows:first.rows.map((row)=>({date:row.date,close:row.unit_nav*100,
      open:i?null:row.unit_nav*99,high:i?null:row.unit_nav*102,low:i?null:row.unit_nav*98,
      MA5:row.unit_nav*100,MA10:row.unit_nav*100,MA20:row.unit_nav*100,MA60:row.unit_nav*100,
      volume:i?null:100,VOL5:i?null:100,VOL10:i?null:100})),
  }))};
}
const expectedDisclosures = {
  "014194": ["中证芯片产业指数收益率 × 95% + 银行人民币活期存款利率（税后） × 5%", "2021-12-02",
    "https://www.99fund.com/main/products/pofund/014194/fundyield.shtml"],
  "018993": ["中证数字经济主题指数收益率 × 65% + 中证港股通综合指数（人民币）收益率 × 15% + 银行活期存款利率（税后） × 20%",
    "2023-09-12", "https://www.zofund.com/index2015/018993.shtml"],
  "110022": ["中证内地消费主题指数收益率 × 85% + 中债总指数收益率 × 15%", "2010-08-20",
    "https://www.efunds.com.cn/Mobile/fund/110022.shtml"],
};
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
    await page.locator("#search-term").fill(first.name);
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
    await page.locator("#nav-chart canvas").first().waitFor();
    assert.equal(await page.locator("#nav-chart").evaluate((chart)=>
      [...chart.childNodes].some((node)=>node.nodeType===3&&node.textContent.trim())),false);
    assert.match(await page.locator("#returns-source").innerText(),/基金净值来源.*最新确认/);
    assert.ok(page.url().endsWith("/funds.html?fund=000001"));
    assert.equal(await page.locator("#core-metrics article").count(),6);
    const grid = await page.locator("#core-metrics").evaluate((el)=>getComputedStyle(el).gridTemplateColumns.split(" ").length);
    assert.equal(grid,mobile ? 2 : 3);
    const detail=page.locator("#fund-missing-facts");
    assert.equal(await detail.isVisible(),mobile);
    assert.ok(await page.locator("#fund-more dt.fact-missing").count());
    if (mobile) {
      assert.equal(await page.locator("#fund-more dt.fact-missing:visible").count(),0);
      assert.ok(await page.locator("#fund-more dd:not(.fact-missing):visible").count());
      await detail.locator("summary").click();
      assert.deepEqual(await detail.locator("dt:visible").allTextContents(),
        await page.locator("#fund-more dt.fact-missing").allTextContents());
      await detail.locator("summary").click();
    } else {
      assert.ok(await page.locator("#fund-more dt.fact-missing:visible").count());
    }
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
    assert.equal(await page.locator("#benchmark-disclosure").innerText(),"合成比较基准");
    assert.equal(await page.locator("#benchmark-source time").textContent(),first.inception);
    assert.equal(await page.getByRole("heading",{name:"强关联板块指数分析"}).count(),0);
    assert.equal(await page.locator("#benchmark-line").count(),0);
    assert.equal(await page.locator("[data-metric='excess'] strong").innerText(),"—");
    assert.notEqual(await page.locator("[data-metric='sharpe'] strong").innerText(),"—");
    await page.getByRole("button",{name:"自定义",exact:true}).click();
    await page.locator("#fund-start").fill("2026-09-01");
    await page.locator("#fund-end").fill("2026-10-20");
    await page.getByRole("button",{name:"应用区间"}).click();
    assert.match(await page.locator("#range-status").innerText(),/2026-09-01 至 2026-10-20/);
    assert.match(await page.locator("[data-metric='excess'] strong").innerText(),/个百分点/);
    await page.locator("#fund-start").fill("2026-11-01");
    await page.getByRole("button",{name:"应用区间"}).click();
    assert.match(await page.locator("#range-status").innerText(),/开始日期不能晚于结束日期/);
    assert.equal(await value.innerText(),"—");
    await page.getByRole("button",{name:"近1年",exact:true}).click();
    assert.equal(await value.innerText(),initial);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
    await page.screenshot({path:path.join(output,`funds-detail-${width}.png`),fullPage:true});
    await page.locator("#detail-import").setInputFiles({name:"test-fund-bundle.json",mimeType:"application/json",
      buffer:Buffer.from(JSON.stringify(fixtureBundle()))});
    await page.waitForFunction(()=>document.getElementById("detail-status").textContent === "已载入 000001。");
    await page.locator("#nav-raw").click();
    assert.match(await page.locator("#nav-basis").innerText(),/原始单位净值/);
    assert.equal(await page.locator("#sector-chart").count(),0);
    await page.getByRole("link",{name:"返回基金列表"}).click();
    await page.getByRole("link",{name:second.name}).click();
    assert.equal(await page.locator("#benchmark-disclosure").innerText(),"业绩比较基准暂未核实");
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
  const context = await browser.newContext({viewport:{width:390,height:844}});
  const service = "https://snapshot.test";
  const file = await readFile(path.join(site,"funds.html"),"utf8");
  const {analysis_model_version:model} = JSON.parse(await readFile(path.join(site,"build-info.json"),"utf8"));
  await context.route(origin+"funds.html**",(route)=>route.fulfill({contentType:"text/html",
    body:file.replace("<html ",`<html data-analysis-origin="${service}" `)}));
  const requests = [];
  await context.route(service+"/api/analysis**",(route)=>{
    const {searchParams:query} = new URL(route.request().url());
    const symbol = query.get("symbol");
    const category = query.get("category");
    requests.push([symbol,category]);
    const fund = {...first,code:symbol,valuation_frequency:null};
    const data = {snapshot_id:"11111111-1111-4111-8111-111111111111",asset_type:"fund",symbol,
      status:"partial",model_version:model,schema_version:1,data_as_of:fund.rows.at(-1).date,
      expires_at:new Date(Date.now()+60_000).toISOString()};
    if (category === "page") {
      const normalized = normalizeFund(fund);
      const range = selectWindow(normalized,periodStart(data.data_as_of,"1y"),data.data_as_of);
      Object.assign(data,{detail_status:"available",data:{fund,risk:{windows:{"1y":{...range,
        ...analyzePerformance(normalized,range)}}}}});
    }
    return route.fulfill({json:data,headers:{"Access-Control-Allow-Origin":"*"}});
  });
  const page = await context.newPage();
  for (const [code,[formula,since,source]] of Object.entries(expectedDisclosures)) {
    await page.goto(origin+"funds.html?fund="+code);
    await page.locator("#fund-source").getByText(/共享快照/).waitFor();
    assert.equal(await page.locator("#benchmark-disclosure").innerText(),formula);
    assert.equal(await page.locator("#benchmark-source time").textContent(),since);
    assert.equal(await page.locator("#benchmark-source a").getAttribute("href"),source);
    assert.equal(await page.locator("#tracking-index").isVisible(),code==="014194");
    if (code==="014194") assert.equal(await page.locator("#tracking-index").innerText(),"跟踪指数 · 中证芯片产业指数");
    assert.equal(await page.getByRole("heading",{name:"强关联板块指数分析"}).count(),0);
  }
  assert.deepEqual(requests,Object.keys(expectedDisclosures).flatMap((code)=>[[code,null],[code,"page"]]));
  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve)=>server.close(resolve));
}
await writeFile(path.join(output,"funds-browser-report.json"),JSON.stringify(report,null,2)+"\n");
console.log("Fund Pages desktop and mobile checks passed");
