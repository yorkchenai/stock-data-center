// Layout and interaction checks use explicitly labeled synthetic fund histories.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { normalizeFund } from "../web/funds/data.mjs";
import { analyzePerformance, FUND_RISK_REFERENCE, periodStart, selectWindow } from "../web/funds/performance.mjs";

const site = path.resolve(process.env.PAGES_SITE || "work/pages-site");
const output = path.resolve(process.env.BROWSER_OUTPUT || "work/pages-browser");
const prefix = "/stock-data-center/";
const mime = {".html":"text/html",".mjs":"text/javascript",".js":"text/javascript",".css":"text/css",".json":"application/json"};
await mkdir(output,{recursive:true});
let fixtureSina;
const server = createServer(async (request,response)=>{
  try {
    const url = new URL(request.url,"http://localhost");
    const location = url.pathname;
    if (location==="/__fixture-sina" && fixtureSina) return fixtureSina(url.searchParams,response);
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
    await context.route("https://fundcomapi.tiantianfunds.com/**",(route)=>route.abort());
    await context.route("https://stock.finance.sina.com.cn/**",(route)=>route.abort());
    await context.addInitScript(()=>{
      const charts = new Map();
      const labels = new Map();
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text,x,y,...args) {
        const chart = this.canvas.closest(".fund-chart");
        if (chart && (this.fillStyle==="#a94344" || this.fillStyle==="#087e75")) {
          const width = this.measureText(text).width;
          labels.set(`${chart.id}:${text}`,{left:x,x:x+width/2,y,right:x+width,
            width:this.canvas.clientWidth,height:this.canvas.clientHeight});
        }
        return fillText.call(this,text,x,y,...args);
      };
      let chartLibrary;
      Object.defineProperty(window,"LightweightCharts",{
        get:()=>chartLibrary,
        set(library) {
          chartLibrary = {...library,createChart(element,options) {
            const chart = library.createChart(element,options);
            charts.set(element.id,chart);
            return chart;
          }};
        },
      });
      window.extremeLabelIsDrawn = (id,date,value)=>{
        const label = labels.get(`${id}:${value}`);
        const point = charts.get(id)?.timeScale().timeToCoordinate(date);
        return label && Number.isFinite(point) && Math.abs(label.x-point)<1 &&
          label.left>=0 && label.right<=label.width && label.y>0 && label.y<label.height;
      };
    });
    const page = await context.newPage();
    const checkExtreme = (id,date,value)=>page.waitForFunction(({id,date,value})=>window.extremeLabelIsDrawn(id,date,value),
      {id,date,value},{timeout:4_000});
    const errors=[];
    page.on("pageerror",(error)=>errors.push(error.message));
    await page.goto(origin+"funds.html");
    await page.locator("#list-import").setInputFiles(files);
    await page.getByRole("link",{name:first.name}).waitFor();
    await page.getByRole("link",{name:second.name}).waitFor();
    const tbody = page.locator("#fund-table tbody");
    const long = tbody.locator("tr",{hasText:first.name});
    const short = tbody.locator("tr",{hasText:second.name});
    assert.notEqual(await long.locator('[data-column="5y"]').textContent(),"—");
    assert.equal(await short.locator('[data-column="5y"]').textContent(),"—");
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
    assert.ok((await page.locator("#returns-title").boundingBox()).y < (await page.locator("#nav-chart-title").boundingBox()).y);
    const extrema = ()=>page.locator(".chart-extremes span").allTextContents();
    const oneYearExtrema = await extrema();
    assert.equal(oneYearExtrema.length,6);
    assert.ok(oneYearExtrema.every((label,index)=>new RegExp(`${index%2 ? "谷" : "峰"}值 \\d{4}-\\d{2}-\\d{2} ·`).test(label)));
    for (const [index,id] of ["returns-chart","nav-chart","drawdown-chart"].entries()) {
      for (const label of oneYearExtrema.slice(index*2,index*2+2)) {
        const [,date,,value] = label.split(" ");
        await checkExtreme(id,date,value);
      }
    }
    assert.equal(await page.locator("#nav-chart").evaluate((chart)=>
      [...chart.childNodes].some((node)=>node.nodeType===3&&node.textContent.trim())),false);
    assert.match(await page.locator("#returns-source").innerText(),/基金净值来源.*最新确认/);
    assert.ok(page.url().endsWith("/funds.html?fund=000001"));
    const benchmarkCard = page.locator(".fund-identity .fund-benchmark");
    await benchmarkCard.getByRole("heading",{name:"业绩比较基准"}).waitFor();
    assert.ok((await benchmarkCard.boundingBox()).y < (await page.locator("#core-metrics").boundingBox()).y);
    const dataPanel = page.locator("#fund-detail > section:last-child");
    assert.equal(await dataPanel.getAttribute("id"),"fund-data-panel");
    assert.match(await dataPanel.locator("#fund-source").innerText(),/合成界面测试/);
    await dataPanel.locator("#fund-freshness").waitFor();
    await dataPanel.getByText("导入该基金数据",{exact:true}).waitFor();
    assert.equal(await page.locator("#detail-status").isVisible(),false);
    assert.equal(await page.locator("#core-metrics article").count(),5);
    assert.match(await page.locator("#risk-reference-note").innerText(),/2\.5%.*252.*不构成投资建议/);
    const sharpeCard = page.locator('[data-metric="sharpe"]');
    assert.notEqual(await sharpeCard.locator(".metric-result .risk-rating").innerText(),"");
    await sharpeCard.locator("summary").click();
    assert.match(await sharpeCard.locator(".risk-metric-help p").innerText(),/日参考收益率.*√252/);
    assert.equal(await sharpeCard.locator(".risk-rating-ranges dd:visible").count(),7);
    await sharpeCard.locator("summary").click();
    for (const id of ["volatility","sortino"]) {
      const card = page.locator(`[data-metric="${id}"]`);
      await card.locator(".metric-result .risk-rating").waitFor();
      await card.locator("summary").click();
      assert.equal(await card.locator(".risk-rating-ranges dd:visible").count(),id==="sortino" ? 6 : 7);
      await card.locator("summary").click();
    }
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
    await page.getByRole("button",{name:"全部历史",exact:true}).click();
    await page.getByText(`图表视窗 ${first.inception} 至 ${first.rows.at(-1).date}`,{exact:true}).waitFor();
    await page.getByRole("button",{name:"近3年",exact:true}).click();
    assert.notEqual(initial,await value.innerText());
    assert.equal(await page.locator("#fund-nav").innerText(),nav);
    const threeYearExtrema = await extrema();
    assert.notDeepEqual(threeYearExtrema,oneYearExtrema);
    const stats = await page.locator("#core-metrics").innerText();
    if (!mobile) {
      const bound=await page.locator("#returns-chart").boundingBox();
      await page.mouse.move(bound.x+bound.width/2,bound.y+100);
      await page.mouse.wheel(0,-300);
      await page.mouse.move(bound.x+bound.width/2,bound.y+100);
      assert.equal(await page.locator("#core-metrics").innerText(),stats);
      assert.deepEqual(await extrema(),threeYearExtrema);
    }
    assert.equal(await page.locator("#benchmark-disclosure").innerText(),"合成比较基准");
    assert.equal(await page.locator("#benchmark-source [data-date-kind=effective]").textContent(),first.inception);
    assert.match(await page.locator("#benchmark-source").innerText(),/披露日期 未披露/);
    assert.equal(await page.locator("#benchmark-validity").innerText(),"当前有效性待核实");
    assert.equal(await page.getByRole("heading",{name:"强关联板块指数分析"}).count(),0);
    assert.equal(await page.locator("#benchmark-line").count(),0);
    assert.equal(await page.getByText("超额收益",{exact:true}).count(),0);
    assert.notEqual(await page.locator("[data-metric='sharpe'] strong").innerText(),"—");
    await page.getByRole("button",{name:"自定义",exact:true}).click();
    await page.locator("#fund-start").fill("2026-09-01");
    await page.locator("#fund-end").fill("2026-10-20");
    await page.getByRole("button",{name:"应用区间"}).click();
    assert.match(await page.locator("#range-status").innerText(),/2026-09-01 至 2026-10-20/);
    assert.equal(await page.locator("[data-metric='excess']").count(),0);
    await page.locator("#fund-start").fill("2026-11-01");
    await page.getByRole("button",{name:"应用区间"}).click();
    assert.match(await page.locator("#range-status").innerText(),/开始日期不能晚于结束日期/);
    assert.equal(await value.innerText(),"—");
    assert.equal(await sharpeCard.locator("strong").innerText(),"—");
    assert.equal(await sharpeCard.locator(".metric-result .risk-rating").count(),0);
    assert.deepEqual(await extrema(),[]);
    await page.getByRole("button",{name:"近1年",exact:true}).click();
    assert.equal(await value.innerText(),initial);
    assert.deepEqual(await extrema(),oneYearExtrema);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
    await page.screenshot({path:path.join(output,`funds-detail-${width}.png`),fullPage:true});
    await page.locator("#detail-import").setInputFiles({name:"test-fund-bundle.json",mimeType:"application/json",
      buffer:Buffer.from(JSON.stringify(fixtureBundle()))});
    await dataPanel.getByText("已载入 000001。",{exact:true}).waitFor();
    await page.locator("#nav-raw").click();
    assert.match(await page.locator("#nav-basis").innerText(),/原始单位净值/);
    assert.equal(await page.locator("#sector-chart").count(),0);
    const levels = [["2024-02-01",1],["2024-02-02",.5099],["2024-02-05",.66],
      ["2024-02-06",null],["2024-02-07",null],["2024-02-08",null],["2024-02-09",.70],
      ["2025-07-30",1.2],["2026-02-02",1.8],["2026-06-30",2.555],["2026-11-20",1.2429]];
    const segmented = {...first,rows:levels.map(([date,level])=>({date,
      unit_nav:level??.72,return_index:level,return_issue:level==null?"unrecognized_event":null}))};
    await page.locator("#detail-import").setInputFiles({name:"segmented-nav.json",mimeType:"application/json",
      buffer:Buffer.from(JSON.stringify(segmented))});
    await dataPanel.getByText("已载入 000001。",{exact:true}).waitFor();
    await checkExtreme("nav-chart","2026-06-30","2.5550");
    await page.getByRole("button",{name:"全部历史",exact:true}).click();
    await checkExtreme("nav-chart","2026-06-30","2.5550");
    await checkExtreme("nav-chart","2024-02-02","0.5099");
    await page.getByRole("link",{name:"返回基金列表"}).click();
    await page.getByRole("link",{name:second.name}).click();
    assert.equal(await page.locator("#benchmark-disclosure").innerText(),"业绩比较基准暂未核实");
    assert.equal(await page.locator("[data-metric='sharpe'] strong").innerText(),"—");
    assert.equal(await page.locator("[data-metric='excess']").count(),0);
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
    const fund = {...first,code:symbol,synthetic:false,valuation_frequency:null};
    const data = {snapshot_id:"11111111-1111-4111-8111-111111111111",asset_type:"fund",symbol,
      status:"partial",model_version:model,schema_version:1,data_as_of:fund.rows.at(-1).date,
      expires_at:new Date(Date.now()+60_000).toISOString()};
    if (category === "page") {
      const normalized = normalizeFund(fund);
      const range = selectWindow(normalized,periodStart(data.data_as_of,"1y"),data.data_as_of);
      Object.assign(data,{detail_status:"available",data:{fund,risk:{reference:FUND_RISK_REFERENCE,windows:{"1y":{...range,
        ...analyzePerformance(normalized,range)}}}}});
    }
    return route.fulfill({json:data,headers:{"Access-Control-Allow-Origin":"*"}});
  });
  const valuationRequests = [];
  const failedProviders = new Set();
  let staleQuotes = false;
  let delaySina = null;
  let relaySina = false;
  const relayRequests = [];
  await context.route(service+"/api/fund-valuation**",(route)=>{
    const {searchParams} = new URL(route.request().url());
    const symbol = searchParams.get("symbol"), provider = searchParams.get("provider");
    const relay = relaySina && provider==="sina";
    if (relay) relayRequests.push(symbol);
    return route.fulfill({status:relay ? 200 : 502,headers:{"Access-Control-Allow-Origin":"*"},
      json:{symbol,provider,values:[{id:"sina_ds3",value:2.51,change:1.5,updatedAt:"2026-11-26 11:33:00"}]}});
  });
  await context.route("https://fundcomapi.tiantianfunds.com/**",(route)=>{
    const code = new URL(route.request().url()).searchParams.get("FCODES");
    valuationRequests.push(["eastmoney",code]);
    return route.fulfill({status:failedProviders.has("eastmoney") ? 503 : 200,headers:{"Access-Control-Allow-Origin":"*"},
      json:{success:true,data:code==="014194" ? [{FCODE:code,GSZ:1.2297,GSZZL:-1.06,GZTIME:"2026-11-26 11:30"}] : []}});
  });
  fixtureSina = (query,response)=>{
    const code = query.get("symbol");
    valuationRequests.push(["sina",code]);
    const price = code==="018993" ? 2.4485 : 2.9550;
    const payload = {result:{status:{code:0},data:{symbol:code,networth:[{
      pre_date:staleQuotes ? "2026-11-25" : "2026-11-26",min_time:"11:33:00",
      pre_nav:price,growthrate:code==="110022" ? null : 0.011762,pre_nav2:price+0.0198,growthrate2:0.01996,
    }]}}};
    const failed = failedProviders.has("sina");
    const send = ()=>response.writeHead(failed ? 503 : 200,{"Content-Type":"application/json"}).end(JSON.stringify(payload));
    if (delaySina) return void delaySina.then(send);
    return send();
  };
  const estimateScript = await readFile(path.join(site,"funds/valuation.mjs"),"utf8");
  // The live browser suite exercises the real JSONP sandbox; the clock test uses an exact local source.
  await context.route(origin+"funds/valuation.mjs",(route)=>route.fulfill({contentType:"text/javascript",
    body:estimateScript.replace("const data = await readSinaValuation(url.href,signal);",
      'const data = await fetch("/__fixture-sina"+url.search,{signal}).then((response)=>{if (!response.ok) throw new Error("fixture outage"); return response.json();});')}));
  await context.addInitScript(()=>{
    Object.defineProperty(document,"hidden",{get:()=>window.fixtureHidden===true});
  });
  const page = await context.newPage();
  await page.clock.install({time:new Date("2026-11-26T04:25:00Z")});
  const navigate = (code)=>page.evaluate((symbol)=>{
    history.pushState(null,"",`?fund=${symbol}`);
    dispatchEvent(new PopStateEvent("popstate"));
  },code);
  const expectedEstimates = {
    "014194":[["fundgz","估值1","-1.06%"],["sina_ds2","估值2","+1.18%"],["sina_ds3","估值3","+2.00%"]],
    "018993":[["sina_ds2","估值2","+1.18%"],["sina_ds3","估值3","+2.00%"]],
    "110022":[["sina_ds3","估值3","+2.00%"]],
  };
  const renderedEstimates = () => page.locator("#valuation-quotes article").evaluateAll((items)=>items.map((item)=>[
    item.dataset.valuationSource,...Array.from(item.children,(child)=>child.textContent),
  ]));
  for (const [code,[formula,since,source]] of Object.entries(expectedDisclosures)) {
    let resumeSina;
    if (code==="014194") delaySina = new Promise((resolve)=>{resumeSina=resolve;});
    if (page.url()==="about:blank") await page.goto(origin+"funds.html?fund="+code);
    else await navigate(code);
    await page.locator("#fund-source").getByText(/共享快照/).waitFor();
    assert.equal(await page.locator("#benchmark-disclosure").innerText(),formula);
    assert.equal(await page.locator("#benchmark-source [data-date-kind=effective]").textContent(),since);
    assert.equal(await page.locator("#benchmark-source a").last().getAttribute("href"),source);
    assert.equal(await page.locator("#tracking-index").isVisible(),code==="014194");
    if (code==="014194") assert.equal(await page.locator("#tracking-index").innerText(),"跟踪指数 · 中证芯片产业指数");
    assert.equal(await page.getByRole("heading",{name:"强关联板块指数分析"}).count(),0);
    assert.equal(await page.locator("#benchmark-source [data-date-kind=published]").textContent(),
      code==="018993" ? "2026-10-20" : "2026-10-27");
    assert.equal(await page.locator("#benchmark-validity").isVisible(),false);
    const estimates = page.locator("#valuation-quotes article");
    await estimates.first().waitFor({timeout:18_000}).catch(async (error)=>{
      throw new Error(`${code} · ${await page.locator("#valuation-status").innerText()} · ${JSON.stringify(valuationRequests)}`,{cause:error});
    });
    if (resumeSina) {
      assert.deepEqual(await renderedEstimates(),[expectedEstimates[code][0]]);
      await page.getByText("正在更新估值…",{exact:true}).waitFor();
      resumeSina();
      delaySina = null;
    }
    await page.locator("#valuation-refresh:enabled").waitFor();
    assert.deepEqual(await renderedEstimates(),expectedEstimates[code]);
    if (code==="014194") {
      failedProviders.add("sina");
      await page.getByRole("button",{name:"刷新估值"}).click();
      await page.getByText("部分估值来源更新失败 · 保留上次成功估值",{exact:true}).waitFor();
      assert.deepEqual(await renderedEstimates(),expectedEstimates[code]);
      failedProviders.clear();
    }
    assert.equal(await page.locator("#fund-nav").innerText(),first.rows.at(-1).unit_nav.toFixed(4));
  }
  assert.deepEqual(requests,Object.keys(expectedDisclosures).flatMap((code)=>[[code,null],[code,"page"]]));
  const quote = page.locator("#valuation-quotes article").first();
  const previous = await quote.innerText();
  const currentCode = "018993";
  const navCount = requests.length;
  let valuationCount = valuationRequests.length;
  await page.clock.fastForward(60_000);
  await page.waitForFunction(()=>!document.getElementById("valuation-refresh").disabled);
  assert.deepEqual(valuationRequests.slice(valuationCount).sort(),[["eastmoney",currentCode],["sina",currentCode]]);

  valuationCount = valuationRequests.length;
  await page.evaluate(()=>{
    window.fixtureHidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(120_000);
  assert.equal(valuationRequests.length,valuationCount);
  await page.evaluate(()=>{
    window.fixtureHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(()=>!document.getElementById("valuation-refresh").disabled);
  assert.deepEqual(valuationRequests.slice(valuationCount).sort(),[["eastmoney",currentCode],["sina",currentCode]]);

  failedProviders.add("eastmoney");
  await page.getByRole("button",{name:"刷新估值"}).click();
  await page.getByText("部分估值来源更新失败",{exact:true}).waitFor();
  assert.deepEqual(await renderedEstimates(),expectedEstimates[currentCode]);
  failedProviders.clear();

  valuationCount = valuationRequests.length;
  await page.getByRole("button",{name:"刷新估值"}).click();
  await page.locator("#valuation-refresh:enabled").waitFor();
  assert.deepEqual(valuationRequests.slice(valuationCount).sort(),[
    ["eastmoney",currentCode],["sina",currentCode],
  ]);
  assert.deepEqual(await renderedEstimates(),expectedEstimates[currentCode]);
  assert.equal(await page.locator("#valuation-status").isVisible(),false);

  relaySina = true;
  valuationCount = valuationRequests.length;
  await page.getByRole("button",{name:"刷新估值"}).click();
  await page.locator("#valuation-refresh:enabled").waitFor();
  assert.deepEqual(relayRequests,[currentCode]);
  assert.deepEqual(valuationRequests.slice(valuationCount),[["eastmoney",currentCode]]);
  assert.deepEqual(await renderedEstimates(),[["sina_ds3","估值3","+1.50%"]]);
  relaySina = false;
  await page.getByRole("button",{name:"刷新估值"}).click();
  await page.locator("#valuation-refresh:enabled").waitFor();

  failedProviders.add("eastmoney");
  failedProviders.add("sina");
  await page.getByRole("button",{name:"刷新估值"}).click();
  await page.getByText("更新失败 · 保留上次成功估值",{exact:true}).waitFor();
  assert.equal(await quote.innerText(),previous);
  failedProviders.clear();
  staleQuotes = true;
  await page.getByRole("button",{name:"刷新估值"}).click();
  await page.getByText("暂无当日估值",{exact:true}).waitFor();
  assert.equal(await page.locator("#valuation-quotes article").count(),0);
  assert.equal(requests.length,navCount);
  await navigate("003095");
  await page.getByText("历史基准披露",{exact:true}).click();
  const old = page.locator("#benchmark-history-list li").first();
  assert.match(await old.innerText(),/65%.*35%/);
  assert.equal(await old.locator("[data-date-kind=published]").textContent(),"2026-10-27");
  assert.equal(await old.locator("[data-date-kind=effective]").textContent(),"2026-07-01");
  assert.equal(await old.locator("a").count(),1);

  const listHistoryLoads = requests.length;
  staleQuotes = false;
  await page.goto(origin+"funds.html");
  const table = page.locator("#fund-table");
  const savedFund = table.locator('tr[data-fund-code="018993"]');
  await savedFund.locator('[data-estimate="sina_ds3"]').getByText("+2.00%",{exact:true}).waitFor();
  const headings = await table.locator("th").allTextContents();
  const navColumn = headings.indexOf("最新单位净值");
  assert.deepEqual(headings.slice(navColumn-3,navColumn),["估值1","估值2","估值3"]);
  assert.deepEqual(await savedFund.locator("td[data-estimate]").allTextContents(),["—","+1.18%","+2.00%"]);
  assert.equal(await savedFund.locator('[data-column="nav"]').textContent(),"—");
  await table.getByRole("button",{name:"估值1",exact:true}).click();
  assert.equal(await table.locator("tbody tr").first().getAttribute("data-fund-code"),"014194");
  staleQuotes = true;
  await page.clock.fastForward(60_000);
  await savedFund.locator('[data-estimate="sina_ds3"]').getByText("—",{exact:true}).waitFor();
  assert.equal(requests.length,listHistoryLoads);
  report.valuation = {fixedLabels:true,listColumns:true,automatic:true,background:true,manual:true,retainsLastQuote:true,historyLoads:0};
  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve)=>server.close(resolve));
}
await writeFile(path.join(output,"funds-browser-report.json"),JSON.stringify(report,null,2)+"\n");
console.log("Fund Pages desktop and mobile checks passed");
