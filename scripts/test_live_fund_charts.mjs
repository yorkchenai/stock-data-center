import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const origin=process.env.FUND_CHART_URL??"http://127.0.0.1:8766";
const output=process.env.FUND_CHART_OUTPUT??"work/fund-chart-review";
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??"/usr/bin/chromium",
  headless:true,args:["--no-sandbox"]});
const codes=["110022","006751","003095"];
const report={mode:"live fund NAV, returns, and risk charts",funds:{}};
const disclosures={
  "110022":["中证内地消费主题指数收益率 × 85% + 中债总指数收益率 × 15%","2010-08-20",
    "https://www.efunds.com.cn/Mobile/fund/110022.shtml"],
  "006751":["中证互联网指数收益率 × 65% + 恒生科技指数收益率 × 20% + 中债-国债总财富（1-3年）指数收益率 × 15%","2026-07-27",
    "https://www.fullgoal.com.cn/noticedetails/107041/index.html"],
  "003095":["中证医药卫生指数收益率 × 90% + 中证综合债指数收益率 × 10%","2026-09-21",
    "https://www.zofund.com/2026/wsnotice/20261027/ebc7404b0b5b47b8a35e82b4fc5607f6.pdf"],
};
const formatReturn=(value)=>`${value*100>=.005?"+":""}${(value*100).toFixed(2)}%`;
async function lookup(path) {
  const response=await fetch(new URL("/api/funds/"+path,origin),{signal:AbortSignal.timeout(300000)});
  assert.equal(response.status,200,await response.clone().text().then((body)=>body.slice(0,200)));
  return response.json();
}
async function open(page,code) {
  await page.addInitScript(()=>{
    let library;
    Object.defineProperty(window,"LightweightCharts",{
      get:()=>library,
      set:(original)=>{
        library={...original,createChart(element,options){
          const chart=original.createChart(element,options);
          if (element.id==="returns-chart") {
            const series=[];
            window.testReturns={chart,series};
            const addSeries=chart.addSeries.bind(chart);
            chart.addSeries=(type,settings)=>{
              const line=addSeries(type,settings);
              series.push(line);
              return line;
            };
          }
          return chart;
        }};
      },
    });
  });
  await page.goto(`${origin}/funds.html?fund=${code}`);
  await page.locator("#nav-chart canvas").first().waitFor({timeout:30000});
}

async function verifyLayout(page, width, height, mobile) {
  await page.evaluate(()=>new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const dimensions=await page.evaluate(()=>{
    const ids=["nav-chart","returns-chart","drawdown-chart"];
    const charts=ids.map((id)=>{
      const node=document.getElementById(id);
      const rect=node.getBoundingClientRect();
      return {id, width:rect.width, height:rect.height, left:rect.left, right:rect.right,
        fits:Array.from(node.querySelectorAll("canvas")).every((canvas)=>{
          const bounds=canvas.getBoundingClientRect();
          // Lightweight Charts may add two pixels at pane separators.
          return bounds.right<=rect.right+1 && bounds.bottom<=rect.bottom+3;
        })};
    });
    const columns=getComputedStyle(document.getElementById("core-metrics")).gridTemplateColumns.split(" ").length;
    const targets=[...document.querySelectorAll("#fund-periods button")];
    const disclosure=document.getElementById("benchmark-disclosure");
    const axisWidth=window.testReturns.chart.priceScale("right").width();
    const fontSize=(selector)=>parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
    return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,charts,columns,axisWidth,
      titleSize:fontSize("#fund-title"),metricSize:fontSize(".metric strong"),
      riskSize:fontSize(".risk-metric strong"),
      disclosureFits:disclosure.scrollWidth<=disclosure.clientWidth,
      minimumTarget:Math.min(...targets.map((button)=>button.getBoundingClientRect().height)),
      navTextNodes:[...document.getElementById("nav-chart").childNodes].some((node)=>node.nodeType===3&&node.textContent.trim())};
  });
  assert.equal(dimensions.width,width);
  assert.equal(dimensions.height,height);
  assert.ok(dimensions.scrollWidth<=width+1,JSON.stringify(dimensions));
  assert.ok(dimensions.charts.every(({width,left,right,fits})=>width>0&&left>=0&&right<=dimensions.width+1&&fits),
    JSON.stringify(dimensions));
  assert.equal(dimensions.navTextNodes,false,"loading or empty-state text must not cover the live NAV chart");
  assert.equal(dimensions.columns,mobile?2:3);
  assert.equal(dimensions.disclosureFits,true);
  assert.ok(dimensions.axisWidth>=57,JSON.stringify(dimensions));
  assert.ok(dimensions.minimumTarget>=(mobile?44:36));
  assert.deepEqual([dimensions.titleSize,dimensions.metricSize],mobile ? [20,20] : [27,25]);
  return {height,columns:dimensions.columns,
    titleSize:dimensions.titleSize,metricSize:dimensions.metricSize,riskSize:dimensions.riskSize};
}

async function hoverMiddle(page, selector) {
  const target=page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  const bounds=await target.boundingBox();
  await page.mouse.move(bounds.x+bounds.width*.53,bounds.y+bounds.height*.45);
}

async function checkDisclosure(page, code) {
  const [formula,since,url]=disclosures[code];
  const disclosure=page.locator("#benchmark-disclosure");
  assert.equal(await disclosure.textContent(),formula);
  assert.equal(await page.locator("#benchmark-source time").textContent(),since);
  assert.equal(await page.locator("#benchmark-source a").getAttribute("href"),url);
  assert.equal(await page.locator("#benchmark-line,#benchmark-status").count(),0);
  return {formula,url};
}

async function checkReturns(page, fund, checkHover=true) {
  const chart=page.locator("#returns-chart");
  const [start,end]=(await page.locator("#range-status").textContent()).match(/\d{4}-\d{2}-\d{2}/g);
  const rows=fund.rows.filter((row)=>row.date>=start&&row.date<=end);
  assert.ok(rows.every((row)=>row.return_index>0));
  const rendered=await page.evaluate(()=>{
    const {chart,series}=window.testReturns;
    const values=[.125,-.125,0];
    return {points:series[0].data(),series:series.length,axis:values.map(chart.options().localization.priceFormatter),
      labels:values.map((value)=>series[0].priceFormatter().format(value))};
  });
  assert.equal(rendered.series,1);
  assert.deepEqual(rendered.axis,["+12.50%","-12.50%","0.00%"]);
  assert.deepEqual(rendered.labels,rendered.axis);
  assert.equal(rendered.points.length,rows.length);
  for (const [i,point] of rendered.points.entries()) {
    assert.equal(point.time,rows[i].date);
    assert.ok(Math.abs(point.value-(rows[i].return_index/rows[0].return_index-1))<1e-12);
  }
  assert.equal(rendered.points[0].value,0);
  const last=formatReturn(rendered.points.at(-1).value);
  const metric=await page.locator('[data-metric="return"] strong').textContent();
  assert.equal(parseFloat(metric),parseFloat(last));
  let peak=rows[0].return_index, maxDrawdown=0;
  for (const row of rows) {
    peak=Math.max(peak,row.return_index);
    maxDrawdown=Math.min(maxDrawdown,row.return_index/peak-1);
  }
  const drawdown=`${(maxDrawdown*100).toFixed(2)}%`;
  assert.equal(await page.locator('[data-metric="drawdown"] strong').textContent(),drawdown);
  assert.equal(await page.locator("#risk-metrics .risk-metric").nth(1).locator("strong").textContent(),drawdown);
  if (checkHover) {
    await chart.scrollIntoViewIfNeeded();
    const plot=await chart.boundingBox();
    for (const [date,expected] of [[start,"0.00%"],[end,last]]) {
      const x=await page.evaluate((day)=>window.testReturns.chart.timeScale().timeToCoordinate(day),date);
      assert.ok(Number.isFinite(x));
      await page.mouse.move(plot.x+x,plot.y+plot.height*.45);
      assert.equal(await page.locator("#hover-values").textContent(),`${date} · 累计收益率 ${expected}`);
    }
    await page.mouse.move(0,0);
    assert.equal(await page.locator("#hover-values").textContent(),"");
  }
  return {start,end,first:"0.00%",last,drawdown};
}

try {
  for (const code of codes) {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];
    const sectorRequests=[];
    page.on("pageerror",(error)=>errors.push(error.message));
    page.on("request",(request)=>{
      if (new URL(request.url()).pathname.includes("/sectors")) sectorRequests.push(request.url());
    });
    await open(page,code);
    const fund=await lookup(code);
    const latestFund=fund.rows.at(-1);
    assert.equal(await page.locator("#core-metrics .metric").count(),6);
    assert.equal(await page.locator("#returns-chart canvas").count()>0,true);
    assert.equal(await page.locator("#drawdown-chart canvas").count()>0,true);
    assert.match(await page.locator("#fund-identity").textContent(),new RegExp(code));
    assert.equal(await page.locator("#fund-nav-date").textContent(),latestFund.date);
    assert.ok((await page.locator("#returns-source").textContent()).includes(latestFund.date));
    assert.ok((await page.locator("#returns-source").textContent()).includes(fund.source.name));
    const headings=await page.locator("#fund-detail h2").allTextContents();
    assert.deepEqual(headings.slice(0,4),["基金历史净值","基金累计收益率","业绩比较基准","风险分析"]);
    const incoming=await page.locator("#nav-hover").textContent();
    assert.match(incoming,/^最新可见 \d{4}-\d{2}-\d{2} · \d+\.\d{4}$/);
    assert.match(await page.locator("#nav-basis").textContent(),/净值按每份显示/);
    await page.locator("#nav-raw").click();
    assert.match(await page.locator("#nav-basis").textContent(),/原始单位净值/);
    assert.ok(await page.locator("#nav-chart canvas").count()>0);
    const rawNav=(await page.locator("#nav-hover").textContent()).match(/(\d{4}-\d{2}-\d{2}) · (\d+\.\d+)/);
    assert.ok(rawNav);
    assert.equal(rawNav[1],latestFund.date);
    assert.equal(rawNav[2],latestFund.unit_nav.toFixed(4));
    await hoverMiddle(page,"#nav-chart");
    const navHover=(await page.locator("#nav-hover").textContent()).match(/^(\d{4}-\d{2}-\d{2}) · (\d+\.\d{4})$/);
    assert.ok(navHover);
    assert.equal(navHover[2],fund.rows.find((row)=>row.date===navHover[1]).unit_nav.toFixed(4));
    await page.locator("#nav-adjusted").click();
    assert.equal(await page.locator("#nav-hover").textContent(),incoming);
    const benchmark=await checkDisclosure(page,code);
    const oneYear=await checkReturns(page,fund);
    await hoverMiddle(page,"#returns-chart");
    const returnHover=await page.locator("#hover-values").textContent();
    assert.match(returnHover,/^\d{4}-\d{2}-\d{2} · 累计收益率 [+-]?\d+\.\d{2}%/);
    assert.ok(fund.rows.some((row)=>row.date===returnHover.slice(0,10)));
    const firstFundRange=await page.locator("#fund-visible-range").textContent();
    await page.locator('#fund-periods [data-period="3m"]').click();
    await page.waitForFunction((initial)=>document.getElementById("fund-visible-range").textContent!==initial,firstFundRange);
    assert.equal(await page.locator("#hover-values").textContent(),"");
    const threeMonths=await checkReturns(page,fund);
    await page.locator('[aria-labelledby="returns-title"]').screenshot({path:`${output}/detail-returns-${code}-3m.png`});
    if (code==="110022") {
      await hoverMiddle(page,"#returns-chart");
      const chart=await page.locator("#returns-chart").boundingBox();
      const before=await page.locator("#fund-visible-range").textContent();
      await page.mouse.wheel(0,-520);
      await page.waitForFunction((from)=>document.getElementById("fund-visible-range").textContent!==from,before);
      const afterZoom=await page.locator("#fund-visible-range").textContent();
      const y=chart.y+chart.height*.45;
      await page.mouse.move(chart.x+chart.width*.53,y);
      await page.mouse.down();
      await page.mouse.move(chart.x+chart.width*.74,y,{steps:12});
      await page.mouse.up();
      await page.waitForFunction((from)=>document.getElementById("fund-visible-range").textContent!==from,afterZoom);
      await hoverMiddle(page,"#returns-chart");
      assert.match(await page.locator("#hover-values").textContent(),/累计收益率 [+-]?\d+\.\d{2}%$/);
    }
    await page.locator('#fund-periods [data-period="1y"]').click();
    await page.waitForFunction((initial)=>document.getElementById("fund-visible-range").textContent===initial,firstFundRange);
    const navGaps=fund.rows.filter((row)=>row.return_index==null);
    if (navGaps.length) {
      await page.locator('#fund-periods [data-period="all"]').click();
      assert.equal(await page.locator("#nav-gaps").isVisible(),true);
      const gaps=await page.locator("#nav-gap-list li").allTextContents();
      assert.deepEqual(gaps.map((item)=>item.slice(0,10)),navGaps.map((row)=>row.date));
      assert.equal(await page.locator("#returns-chart canvas").count(),0);
      assert.match(await page.locator("#returns-chart").textContent(),/当前统计区间暂无可计算的曲线/);
      await page.locator('#fund-periods [data-period="1y"]').click();
    }
    await page.mouse.move(0,0);
    const viewports={};
    for (const width of [1440,1920]) {
      await page.setViewportSize({width,height:1000});
      viewports[width]=await verifyLayout(page,width,1000,false);
      await page.screenshot({path:`${output}/full-${code}-desktop-${width}.png`,fullPage:true});
      if (width===1440) await page.locator('[aria-labelledby="returns-title"]').screenshot({
        path:`${output}/detail-returns-${code}-desktop-${width}.png`,
      });
    }
    assert.deepEqual(errors,[]);
    report.funds[code]={
      nav:{date:rawNav[1],unit_nav:Number(rawNav[2]),adjusted_readout:incoming,gapCount:navGaps.length},
      viewports,benchmark,returns:{oneYear,threeMonths}};

    if (code==="110022") {
      // Same document navigation checks lifecycle, not just a reload.
      await page.evaluate(()=>{
        history.pushState(null,"","funds.html?fund=003095");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await page.waitForFunction(()=>document.getElementById("fund-title").textContent.includes("中欧医疗"));
      await checkDisclosure(page,"003095");
      assert.equal(await page.locator("#hover-values").textContent(),"");
      report.funds[code].switch_cleared=true;
    }
    assert.deepEqual(sectorRequests,[]);
    await page.close();

    const touchViewport=code==="006751" ? {width:430,height:932} : {width:390,height:844};
    const phone=await browser.newPage({viewport:touchViewport,isMobile:true,hasTouch:true,deviceScaleFactor:1});
    await open(phone,code);
    const cdp=await phone.context().newCDPSession(phone);
    await checkDisclosure(phone,code);
    assert.deepEqual(await checkReturns(phone,fund,false),oneYear);
    const returnsChart=phone.locator("#returns-chart");
    await returnsChart.scrollIntoViewIfNeeded();
    const plot=await returnsChart.boundingBox();
    const returnX=plot.x+plot.width*.43,returnY=plot.y+plot.height*.48;
    const returnTouch=(type,...coordinates)=>cdp.send("Input.dispatchTouchEvent",{
      type,touchPoints:coordinates.map((x,i)=>({x,y:returnY,id:i+1})),
    });
    const initialRange=await phone.locator("#fund-visible-range").textContent();
    await returnTouch("touchStart",returnX-18,returnX+18);
    for (let d=26;d<=70;d+=8) await returnTouch("touchMove",returnX-d,returnX+d);
    await returnTouch("touchEnd");
    await phone.waitForFunction((from)=>document.getElementById("fund-visible-range").textContent!==from,initialRange);
    const afterPinch=await phone.locator("#fund-visible-range").textContent();
    await returnTouch("touchStart",returnX);
    for (let d=12;d<=72;d+=12) await returnTouch("touchMove",returnX+d);
    await returnTouch("touchEnd");
    await phone.waitForFunction((from)=>document.getElementById("fund-visible-range").textContent!==from,afterPinch);
    await returnTouch("touchStart",returnX);
    const touchLocator=phone.locator("#hover-values");
    await phone.waitForFunction(()=>document.getElementById("hover-values").textContent.includes("%"));
    const returnTouchReadout=await touchLocator.textContent();
    const touchedReturn=fund.rows.find((row)=>row.date===returnTouchReadout.slice(0,10));
    const returnBase=fund.rows.find((row)=>row.date===oneYear.start);
    assert.ok(touchedReturn);
    assert.equal(returnTouchReadout,`${touchedReturn.date} · 累计收益率 ${formatReturn(touchedReturn.return_index/returnBase.return_index-1)}`);
    await returnTouch("touchEnd");
    await phone.locator('#fund-periods [data-period="1y"]').tap();
    assert.equal(await touchLocator.textContent(),"");
    report.funds[code].returns.touch=returnTouchReadout;
    const missingFacts=phone.locator("#fund-missing-facts");
    if (await missingFacts.isVisible()) {
      assert.equal(await missingFacts.getAttribute("open"),null);
      const fieldNames=await phone.locator("#fund-more dt.fact-missing").allTextContents();
      assert.match(await missingFacts.locator("summary").textContent(),new RegExp(`（${fieldNames.length} 项）`));
      await missingFacts.locator("summary").tap();
      assert.deepEqual(await missingFacts.locator("dt:visible").allTextContents(),fieldNames);
      assert.ok((await missingFacts.locator("dd:visible").allTextContents()).every((value)=>value==="—"));
      await missingFacts.locator("summary").tap();
    }
    for (const [width,height] of [[390,844],[430,932]]) {
      await phone.setViewportSize({width,height});
      // Let the chart respond to the new width before fitting the full comparison range.
      await phone.evaluate(()=>new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await phone.locator('#fund-periods [data-period="1y"]').tap();
      await phone.waitForFunction(({start,end})=>
        document.getElementById("fund-visible-range").textContent===`图表视窗 ${start} 至 ${end}`,oneYear);
      viewports[width]=await verifyLayout(phone,width,height,true);
      await phone.screenshot({path:`${output}/full-${code}-mobile-${width}.png`,fullPage:true});
      await phone.locator('[aria-labelledby="returns-title"]').screenshot({path:`${output}/detail-returns-${code}-mobile-${width}.png`});
    }
    report.funds[code].touchViewport=touchViewport;
    await phone.close();
  }

} finally {
  await writeFile(`${output}/observations.json`,JSON.stringify(report,null,2));
  await browser.close();
}
