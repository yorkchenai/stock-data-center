import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
try {
  for (const width of [1440,390]) {
    const context = await browser.newContext({viewport:{width,height:850},isMobile:width===390,hasTouch:width===390});
    const page = await context.newPage();
    const errors = [];
    const path = new URL("/api/stock-minutes", process.env.WORKER_URL);
    const url = new URL(process.env.PAGES_URL);
    url.searchParams.set("minute-smoke",process.env.GITHUB_RUN_ID);
    page.on("pageerror", error => errors.push(error.message));
    let directAttempts = 0;
    await page.route("https://push2his.eastmoney.com/api/qt/stock/trends2/**", route => {
      directAttempts++;
      return route.abort();
    });
    for (const [symbol,kind] of [["sh000688","index"],["sh600519","stock"],["sz300078","stock"]]) {
      await page.goto(url.href);
      if (symbol !== "sh000688") {
        await page.locator("#symbol").fill(symbol);
        await page.locator("#kind").selectOption(kind);
        await page.locator("#load").click();
      }
      await page.waitForFunction(value => document.querySelector("#instrument-code").textContent.includes(value), symbol, {timeout:60000});
      assert.equal(await page.locator("[data-timeframe=day]").getAttribute("aria-pressed"),"true");
      const got = page.waitForResponse(response => {
        const actual = new URL(response.url());
        return actual.origin===path.origin && actual.pathname===path.pathname &&
          actual.searchParams.get("symbol")===symbol;
      }, {timeout:20000});
      await page.locator("[data-timeframe=minute]").click();
      const response = await got;
      assert.equal(response.status(), 200);
      const payload = await response.json();
      const count = payload.data.trends.length;
      assert.ok(count>=240);
      const last = payload.data.trends.at(-1).split(",")[0];
      assert.match(last, / 15:00$/);
      await page.waitForFunction(n => document.querySelector("#history-label").textContent.includes(n+" 条"), count);
      assert.match(await page.locator("#timeframe-status").innerText(), /15:00.*自动刷新暂停/);
      assert.equal(await page.locator(".pane-legend").count(),5);
      assert.equal(await page.locator("#selected-date").innerText(),"15:00");
      await page.locator("[data-timeframe=day]").click();
      assert.equal(await page.locator("[data-timeframe=day]").getAttribute("aria-pressed"),"true");
      console.log({width,symbol,count,last,fromWorker:true});
    }
    assert.equal(directAttempts,0);
    assert.deepEqual(errors,[]);
    await context.close();
  }
} finally { await browser.close(); }
