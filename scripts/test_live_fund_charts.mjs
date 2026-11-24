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
  await page.goto(`${origin}/funds.html?fund=${code}`);
  await page.locator("#nav-chart canvas").first().waitFor({timeout:30000});
  await page.locator(chartCanvas).first().waitFor({timeout:300_000});
}

try {
  for (const [code,target] of cases) {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];
    page.on("pageerror",(error)=>errors.push(error.message));
    await open(page,code);
    assert.equal(await page.locator("#core-metrics .metric").count(),6);
    assert.equal(await page.locator("#returns-chart canvas").count()>0,true);
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
    await page.locator("#nav-raw").click();
    assert.match(await page.locator("#nav-basis").textContent(),/原始单位净值/);
    assert.ok(await page.locator("#nav-chart canvas").count()>0);
    const rawNav=(await page.locator("#nav-hover").textContent()).match(/(\d{4}-\d{2}-\d{2}) · (\d+\.\d+)/);
    assert.ok(rawNav && Number(rawNav[2])>0);
    await page.locator("#nav-adjusted").click();
    assert.equal(await page.locator("#nav-hover").textContent(),incoming);
    await page.locator('[data-indicator="MA5"]').uncheck();
    await page.locator("#sector-chart").scrollIntoViewIfNeeded();
    const chart=await page.locator("#sector-chart").boundingBox();
    const hoverX=chart.x+chart.width*.55;
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
    if (slots>1) {
      const other=model.sectors.find((item)=>item.code!==index.code);
      await page.locator(`[data-index="${other.code}"]`).click();
      await page.locator(chartCanvas).first().waitFor();
      const alternate=await lookup(`${code}/sectors/${other.code}`);
      assert.ok((await page.locator("#sector-index-meta").textContent()).includes(alternate.source.name));
      if (await page.locator("#sector-chart").getAttribute("data-chart-mode")==="close") report.closeOnly={fund:code,index:other.code};
      await page.locator(`[data-index="${index.code}"]`).click();
      await page.locator(chartCanvas).first().waitFor();
    }
    await page.locator('#sector-periods [data-period="1y"]').click();
    await page.mouse.move(0,0);
    await page.screenshot({path:`${output}/${code}-desktop.png`,fullPage:true});
    assert.deepEqual(errors,[]);
    report.funds[code]={selected:index.code,quality:price.quality,first:price.first,last:price.last,
      nav:{date:rawNav[1],unit_nav:Number(rawNav[2]),adjusted_readout:incoming},
      mode:chartMode,ohlc:(({date,open,high,low,close})=>({date,open,high,low,close}))(price.rows.at(-1)),
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
      report.funds[code].switch_cleared=true;
    }
    await page.close();

    const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
    await open(phone,code);
    if (model.sectors[0].code!==target) {
      await phone.locator(`[data-index="${target}"]`).tap();
      await phone.locator(chartCanvas).first().waitFor();
    }
    assert.equal(await phone.locator("#sector-vol label").count(),3);
    await phone.locator("#sector-chart").scrollIntoViewIfNeeded();
    const bounds=await phone.locator("#sector-chart").boundingBox();
    const x=bounds.x+bounds.width*.48,y=bounds.y+bounds.height*.5;
    const cdp=await phone.context().newCDPSession(phone);
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
    await phone.locator('#sector-periods [data-period="1y"]').tap();
    assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await phone.screenshot({path:`${output}/${code}-mobile.png`,fullPage:true});
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
      await page.screenshot({path:`${output}/close-only-desktop.png`,fullPage:true});
      break;
    }
    await page.close();
  }
  assert.ok(report.closeOnly,"a real close-only index must exercise the downgrade");
} finally {
  await writeFile(`${output}/observations.json`,JSON.stringify(report,null,2));
  await browser.close();
}
