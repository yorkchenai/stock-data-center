import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const origin=process.env.FUND_CHART_URL??"http://127.0.0.1:8766";
const output=process.env.FUND_CHART_OUTPUT??"work/fund-chart-review";
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??"/usr/bin/chromium",
  headless:true,args:["--no-sandbox"]});
const chartCanvas="#sector-chart canvas";
const cases=[["110022","399997"],["006751","000994"],["003095","000991"]];
const report={mode:"live fund data, CSI rankings and stock-engine charts",funds:{},closeOnly:null};
const disclosures={
  "110022":["暂未核实",null],
  "006751":["中证互联网指数收益率×65%＋恒生科技指数收益率×20%＋中债-国债总财富（1-3年）指数收益率×15%（2026-07-27起）",
    "https://paper.cnstock.com/html/2026-06/27/content_2236123.htm"],
  "003095":["中证医药卫生指数收益率×90%＋中证综合债指数收益率×10%（2026-09-21起）",
    "https://www.zofund.com/2026/wsnotice/20261027/ebc7404b0b5b47b8a35e82b4fc5607f6.pdf"],
};
const formatReturn=(value)=>`${value*100>=.005?"+":""}${(value*100).toFixed(2)}%`;
async function lookup(path) {
  const response=await fetch(new URL("/api/funds/"+path,origin),{signal:AbortSignal.timeout(300000)});
  assert.equal(response.status,200,await response.clone().text().then((body)=>body.slice(0,200)));
  return response.json();
}
function checkAverages(payload, field, label, periods) {
  const last=payload.rows.at(-1);
  const checks={};
  for (const n of periods) {
    const key=label+n;
    const period=payload.rows.slice(-n);
    const enough=period.length===n && period.every((value)=>Number.isFinite(value[field]));
    if (!enough) {
      assert.equal(last[key],null);
      continue;
    }
    const mean=period.reduce((total,x)=>total+x[field],0)/n;
    assert.ok(Number.isFinite(last[key])&&Math.abs(mean-last[key])<1e-7,key);
    checks[key]=last[key];
  }
  return checks;
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
  await page.locator(chartCanvas).first().waitFor({timeout:300_000});
}

async function verifyLayout(page, width, mobile) {
  await page.evaluate(()=>new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const dimensions=await page.evaluate(()=>{
    const ids=["nav-chart","returns-chart","drawdown-chart","sector-chart"];
    const charts=ids.map((id)=>{
      const node=document.getElementById(id);
      const rect=node.getBoundingClientRect();
      return {id, width:rect.width, left:rect.left, right:rect.right,
        fits:Array.from(node.querySelectorAll("canvas")).every((canvas)=>{
          const bounds=canvas.getBoundingClientRect();
          // Lightweight Charts may add two pixels at pane separators.
          return bounds.right<=rect.right+1 && bounds.bottom<=rect.bottom+3;
        })};
    });
    const panes=[...document.querySelectorAll("#sector-chart table tr")]
      .map((row)=>row.getBoundingClientRect().height).filter((height)=>height>30);
    const columns=getComputedStyle(document.getElementById("core-metrics")).gridTemplateColumns.split(" ").length;
    const targets=[...document.querySelectorAll("#sector-tabs button,#sector-periods button,#fund-periods button")];
    const disclosure=document.getElementById("benchmark-disclosure");
    const axisWidth=window.testReturns.chart.priceScale("right").width();
    return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,charts,panes,columns,axisWidth,
      disclosureFits:disclosure.scrollWidth<=disclosure.clientWidth,
      minimumTarget:Math.min(...targets.map((button)=>button.getBoundingClientRect().height)),
      tabLabelFits:[...document.querySelectorAll("#sector-tabs button")].every((tab)=>tab.scrollWidth<=tab.clientWidth),
      navTextNodes:[...document.getElementById("nav-chart").childNodes].some((node)=>node.nodeType===3&&node.textContent.trim())};
  });
  assert.equal(dimensions.width,width);
  assert.ok(dimensions.scrollWidth<=width+1,JSON.stringify(dimensions));
  assert.ok(dimensions.charts.every(({width,left,right,fits})=>width>0&&left>=0&&right<=dimensions.width+1&&fits),
    JSON.stringify(dimensions));
  assert.equal(dimensions.navTextNodes,false,"loading or empty-state text must not cover the live NAV chart");
  assert.equal(dimensions.columns,mobile?2:3);
  assert.equal(dimensions.tabLabelFits,true);
  assert.equal(dimensions.disclosureFits,true);
  assert.ok(dimensions.axisWidth>=57,JSON.stringify(dimensions));
  assert.ok(dimensions.minimumTarget>=(mobile?44:36));
  assert.equal(dimensions.panes.length,2,JSON.stringify(dimensions.panes));
  assert.ok(Math.abs(dimensions.panes[1]/(dimensions.panes[0]+dimensions.panes[1])-.3)<.04,
    JSON.stringify(dimensions.panes));
  return dimensions.panes;
}

async function hoverMiddle(page, selector) {
  const target=page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  const bounds=await target.boundingBox();
  await page.mouse.move(bounds.x+bounds.width*.53,bounds.y+bounds.height*.45);
}

async function checkDisclosure(page, code) {
  const [formula,url]=disclosures[code];
  const disclosure=page.locator("#benchmark-disclosure");
  assert.equal(await disclosure.textContent(),`官方业绩比较基准：${formula}${url?" 查看披露":""}`);
  assert.equal(await disclosure.locator("a").count(),url?1:0);
  if (url) assert.equal(await disclosure.locator("a").getAttribute("href"),url);
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
  return {start,end,first:"0.00%",last};
}

try {
  for (const [code,target] of cases) {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];
    page.on("pageerror",(error)=>errors.push(error.message));
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
    assert.deepEqual(headings.slice(0,4),["基金历史净值","基金累计收益率","风险分析","强关联板块指数分析"]);
    const model=await lookup(`${code}/sectors`);
    const slots=await page.locator("#sector-tabs button").count();
    assert.equal(slots,model.sectors.length);
    assert.ok(slots>=1&&slots<=5);
    const index=model.sectors.find((item)=>item.code===target);
    assert.ok(index,`${target} should be in the live ranking for ${code}`);
    if (code==="110022") assert.equal(index.holdings.status,"direct_support");
    if (model.sectors[0].code!==target) {
      await page.locator(`[data-index="${target}"]`).click();
      await page.locator(chartCanvas).first().waitFor();
    }
    const price=await lookup(`${code}/sectors/${index.code}`);
    assert.equal(await page.locator("#sector-index-title").textContent(),`${index.name} ${index.code}`);
    const ma=checkAverages(price,"close","MA",[5,10,20,60]);
    const vol=checkAverages(price,"volume","VOL",[5,10]);
    assert.equal(Object.keys(vol).length,2);
    assert.ok(["eastmoney","tencent"].includes(price.source.id));
    const chartMode=await page.locator("#sector-chart").getAttribute("data-chart-mode");
    assert.equal(chartMode,"candles");
    assert.equal(price.volume_unit,"手");
    assert.equal(price.quality.volume_status,"available");
    assert.ok(price.quality.volume_coverage?.last);
    assert.equal(await page.locator("#sector-vol label").count(),3);
    assert.match(await page.locator("#sector-volume-note").textContent(),/日成交量 · 手/);
    assert.equal(await page.locator("#sector-chart.with-volume").count(),1);
    assert.match(await page.locator("#sector-metrics").textContent(),/60\/120 日/);
    if (code==="110022") assert.match(await page.locator("#sector-evidence").textContent(),/直接支持/);
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
    await page.locator('[data-indicator="MA5"]').uncheck();
    await page.locator("#sector-chart").scrollIntoViewIfNeeded();
    const chart=await page.locator("#sector-chart").boundingBox();
    const hoverX=chart.x+chart.width*.55;
    let intervalRequests=0;
    const countSectorRequests=(request)=>{if (new URL(request.url()).pathname.includes("/sectors/")) intervalRequests++;};
    page.on("request",countSectorRequests);
    await page.mouse.move(hoverX,chart.y+chart.height*.37);
    await page.waitForTimeout(150);
    const hover=await page.locator("#sector-ohlc").textContent();
    assert.match(hover,/\d{4}-\d{2}-\d{2} · 开/);
    assert.notEqual(hover.slice(0,10),price.last);
    const hovered=price.rows.find((row)=>row.date===hover.slice(0,10));
    const locale=new Intl.NumberFormat("zh-CN",{maximumFractionDigits:2});
    assert.ok(hovered);
    const hoverMA5=await page.locator('[data-readout="MA5"]').textContent();
    assert.equal(hoverMA5,hovered.MA5==null?"—":locale.format(hovered.MA5));
    await page.mouse.move(hoverX,chart.y+chart.height*.82);
    assert.equal(await page.locator("#sector-ohlc").textContent(),hover);
    for (const field of ["volume","VOL5","VOL10"]) {
      assert.equal(await page.locator(`[data-readout="${field}"]`).textContent(),
        hovered[field]==null?"—":locale.format(hovered[field]));
    }
    for (const field of ["volume","VOL5","VOL10"]) {
      await page.locator(`[data-indicator="${field}"]`).uncheck();
      await page.locator(`[data-indicator="${field}"]`).check();
    }
    await page.mouse.move(hoverX,chart.y+chart.height*.37);
    const before=await page.locator("#sector-chart").getAttribute("data-visible-from");
    await page.mouse.wheel(0,-520);
    await page.waitForTimeout(300);
    const zoomed=await page.locator("#sector-chart").getAttribute("data-visible-from");
    assert.notEqual(zoomed,before);
    await page.mouse.move(chart.x+chart.width*.55,chart.y+chart.height*.43);
    await page.mouse.down();
    await page.mouse.move(chart.x+chart.width*.72,chart.y+chart.height*.43,{steps:12});
    await page.mouse.up();
    await page.waitForTimeout(250);
    const panned=await page.locator("#sector-chart").getAttribute("data-visible-from");
    assert.notEqual(panned,zoomed);
    await page.locator('#sector-periods [data-period="3m"]').click();
    assert.equal(await page.locator('[data-indicator="MA5"]').isChecked(),false);
    await page.locator('[data-indicator="MA5"]').check();
    await page.locator('#sector-periods [data-period="custom"]').click();
    await page.locator("#sector-from").fill(price.last.slice(0,7)+"-01");
    await page.locator("#sector-range button").click();
    assert.match(await page.locator("#sector-range-status").textContent(),/显示/);
    assert.equal(await page.locator('[data-readout="VOL10"]').textContent(),locale.format(vol.VOL10));
    assert.equal(intervalRequests,0);
    page.off("request",countSectorRequests);
    if (slots>1) {
      const other=model.sectors.find((item)=>item.code!==index.code);
      await page.locator(`[data-index="${other.code}"]`).click();
      await page.locator(chartCanvas).first().waitFor();
      const alternate=await lookup(`${code}/sectors/${other.code}`);
      assert.ok((await page.locator("#sector-index-meta").textContent()).includes(alternate.source.name));
      assert.equal(await page.locator("#sector-index-title").textContent(),`${other.name} ${other.code}`);
      const lastRow=alternate.rows.at(-1);
      const expectedOHLC=[alternate.last,...["open","high","low","close"].map((field,i)=>
        `${["开","高","低","收"][i]} ${lastRow[field]==null?"—":locale.format(lastRow[field])}`)].join(" · ");
      assert.equal(await page.locator("#sector-ohlc").textContent(),expectedOHLC);
      if (code==="110022") {
        await page.locator('.sector-panel').screenshot({path:`${output}/detail-${code}-switched-${other.code}.png`});
        report.switchScreenshot={fund:code,index:other.code};
      }
      if (await page.locator("#sector-chart").getAttribute("data-chart-mode")==="close") report.closeOnly={fund:code,index:other.code};
      await page.locator(`[data-index="${index.code}"]`).click();
      await page.locator(chartCanvas).first().waitFor();
    }
    await page.locator('#sector-periods [data-period="1y"]').click();
    await page.mouse.move(0,0);
    const viewports={};
    for (const width of [1440,1920]) {
      await page.setViewportSize({width,height:1000});
      viewports[width]=await verifyLayout(page,width,false);
      await page.screenshot({path:`${output}/full-${code}-desktop-${width}.png`,fullPage:true});
      if (width===1440) await page.locator('[aria-labelledby="returns-title"]').screenshot({
        path:`${output}/detail-returns-${code}-desktop-${width}.png`,
      });
    }
    await page.locator(".sector-panel").screenshot({path:`${output}/detail-${code}-index-${index.code}.png`});
    assert.deepEqual(errors,[]);
    report.funds[code]={selected:index.code,quality:price.quality,first:price.first,last:price.last,
      nav:{date:rawNav[1],unit_nav:Number(rawNav[2]),adjusted_readout:incoming,gapCount:navGaps.length},
      mode:chartMode,viewports,benchmark,returns:{oneYear,threeMonths},
      ohlc:(({date,open,high,low,close})=>({date,open,high,low,close}))(price.rows.at(-1)),
      ma,vol,volume:price.rows.at(-1).volume,source:price.source.id,model_index_as_of:price.model_index_as_of,
      volume_unit:price.volume_unit,volume_status:price.quality.volume_status,ranked:model.sectors.map((item)=>({
        code:item.code,quality:item.quality,rank:item.rank,beta:item.beta,stability:item.stability,
        holdings:item.holdings.status,pearson60:item.windows[60].pearson,pearson120:item.windows[120].pearson,
        partial60:item.windows[60].partial,partial120:item.windows[120].partial,
      })),hover,zoom:true,pan:true};

    if (code==="110022") {
      // Same document navigation checks lifecycle, not just a reload.
      await page.evaluate(()=>{
        history.pushState(null,"","funds.html?fund=003095");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      assert.equal(await page.locator("#sector-tabs button").count(),0);
      await page.waitForFunction(()=>document.getElementById("fund-title").textContent.includes("中欧医疗"));
      await page.locator(chartCanvas).first().waitFor({timeout:300_000});
      assert.equal(await page.locator('[data-index="399997"]').count(),0);
      await checkDisclosure(page,"003095");
      assert.equal(await page.locator("#hover-values").textContent(),"");
      report.funds[code].switch_cleared=true;
    }
    await page.close();

    const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
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
    if (model.sectors[0].code!==target) {
      await phone.locator(`[data-index="${target}"]`).tap();
      await phone.locator(chartCanvas).first().waitFor();
    }
    assert.equal(await phone.locator("#sector-vol label").count(),3);
    await phone.locator("#sector-chart").scrollIntoViewIfNeeded();
    const bounds=await phone.locator("#sector-chart").boundingBox();
    const x=bounds.x+bounds.width*.48,y=bounds.y+bounds.height*.5;
    const touch=(type,x,y)=>cdp.send("Input.dispatchTouchEvent",{
      type,touchPoints:type==="touchEnd"?[]:[{x,y,id:1}],
    });
    const base=await phone.locator("#sector-chart").getAttribute("data-visible-from");
    const send=(type,margin)=>cdp.send("Input.dispatchTouchEvent",{type,touchPoints:margin==null?[]:[
      {x:x-margin,y,id:1},{x:x+margin,y,id:2},
    ]});
    await send("touchStart",18);
    for (let d=26;d<=75;d+=7) await send("touchMove",d);
    await send("touchEnd");
    await phone.waitForTimeout(300);
    const pinch=await phone.locator("#sector-chart").getAttribute("data-visible-from");
    assert.notEqual(pinch,base,"pinch zoom should change the visible first date");
    await touch("touchStart",x,y);
    for (let d=12;d<=84;d+=12) await touch("touchMove",x+d,y);
    await touch("touchEnd",x+84,y);
    await phone.waitForFunction((first)=>document.getElementById("sector-chart").dataset.visibleFrom!==first,pinch);
    await touch("touchStart",x,y);
    await phone.waitForFunction((last)=>!document.getElementById("sector-ohlc").textContent.startsWith(last),price.last);
    const touchReadout=await phone.locator("#sector-ohlc").textContent();
    const touched=price.rows.find((row)=>row.date===touchReadout.slice(0,10));
    assert.ok(touched);
    assert.equal(await phone.locator('[data-readout="volume"]').textContent(),locale.format(touched.volume));
    await touch("touchEnd",x,y);
    await phone.locator('#sector-periods [data-period="3m"]').tap();
    assert.match(await phone.locator("#sector-range-status").textContent(),/显示 \d{4}-\d{2}-\d{2}/);
    for (const width of [390,430]) {
      await phone.setViewportSize({width,height:844});
      await phone.locator('#sector-periods [data-period="1y"]').tap();
      viewports[width]=await verifyLayout(phone,width,true);
      await phone.screenshot({path:`${output}/full-${code}-mobile-${width}.png`,fullPage:true});
      await phone.locator('[aria-labelledby="returns-title"]').screenshot({path:`${output}/detail-returns-${code}-mobile-${width}.png`});
    }
    report.funds[code].touch=touchReadout;
    report.funds[code].pinch=true;
    await phone.close();
  }

  if (!report.closeOnly) {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await open(page,"519674");
    const model=await lookup("519674/sectors");
    for (const item of model.sectors) {
      const data=await lookup(`519674/sectors/${item.code}`);
      if (data.quality.ohlc_rows!==0) continue;
      await page.locator(`[data-index="${item.code}"]`).click();
      await page.locator('#sector-chart[data-chart-mode="close"]').waitFor();
      assert.match(await page.locator("#sector-history-note").textContent(),/收盘价/);
      report.closeOnly={fund:"519674",index:item.code,quality:data.quality};
      await page.screenshot({path:`${output}/full-519674-desktop-1440-close-only.png`,fullPage:true});
      break;
    }
    await page.close();
  }
  assert.ok(report.closeOnly,"a real close-only index must exercise the downgrade");
  assert.ok(report.switchScreenshot,"a switched real index must be captured");
} finally {
  await writeFile(`${output}/observations.json`,JSON.stringify(report,null,2));
  await browser.close();
}
