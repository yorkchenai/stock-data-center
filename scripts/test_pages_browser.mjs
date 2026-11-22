// Headless development checks. No TLS/CORS/security bypass flags are used.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { checkChartControls } from "./pages_chart_checks.mjs";

const site = path.resolve(process.env.PAGES_SITE || "work/pages-site");
const output = process.env.BROWSER_OUTPUT || "work/pages-browser";
await mkdir(output, { recursive: true });
const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".json": "application/json",
};
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (!pathname.startsWith("/stock-data-center/")) {
      response.writeHead(404).end();
      return;
    }
    const file = path.resolve(
      site,
      pathname.slice("/stock-data-center/".length) || "index.html",
    );
    if (!file.startsWith(site + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/json",
    });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const localURL = `http://127.0.0.1:${server.address().port}/stock-data-center/`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const report = {
  at: new Date().toISOString(),
  mode: "offline real-history fixture; NOT live provider verification",
  viewports: [],
};
try {
  const snapshot = JSON.parse(
    await readFile(path.join(site, "api/demo"), "utf8"),
  );
  for (const [width, height, mobile] of [
    [1366, 768, false],
    [1440, 900, false],
    [1920, 1080, false],
    [390, 844, true],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.route("https://push2his.eastmoney.com/**", async (route) => {
      const u = new URL(route.request().url()),
        start = u.searchParams.get("beg"),
        end = u.searchParams.get("end");
      const rows = snapshot.rows.filter(
        (r) =>
          r.date.replaceAll("-", "") >= start &&
          r.date.replaceAll("-", "") <= end,
      );
      await route.fulfill({
        json: {
          data: {
            code: "000688",
            name: "科创50",
            market: 1,
            klines: rows.map((r) =>
              [
                r.date,
                r.open,
                r.close,
                r.high,
                r.low,
                r.volume_lots,
                r.turnover_cny,
              ].join(","),
            ),
          },
        },
      });
    });
    await page.goto(localURL);
    await page.waitForFunction(() =>
      document.querySelector("#history-label").textContent.includes("1,551"),
    );
    assert.match(
      await page.locator("#data-timestamp").textContent(),
      /非最新行情/,
    );
    assert.equal(await page.locator(".pane-legend").count(), 5);
    await page.locator('[data-range="all"]').click();
    await page.waitForFunction(() =>
      document
        .querySelector("#visible-range")
        .textContent.includes("2020-07-01"),
    );
    await page.locator("#display-start").fill("2021-01-01");
    await page.locator("#display-end").fill("2021-12-31");
    const before = requests.length;
    await page.locator("#range-form button").click();
    await page.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("显示区间已调整"),
    );
    assert.equal(
      requests.length,
      before,
      "display date adjustment must never issue requests",
    );
    await page.locator("#load").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#data-timestamp")
        .textContent.includes("取数完成"),
    );
    assert.ok(
      requests.some((url) => url.startsWith("https://push2his.eastmoney.com/")),
    );
    assert.equal(
      await page.locator("#instrument-name").textContent(),
      "科创50",
    );
    const controls = await checkChartControls(page, {
      firstDate: snapshot.rows[0].date,
      lastDate: snapshot.rows.at(-1).date,
      rows: snapshot.rows.length,
      mobile,
    });
    const layout = await page.evaluate(() => {
      const legends = [...document.querySelectorAll(".pane-legend")].map(
        (element) => {
          const r = element.getBoundingClientRect();
          return {
            height: r.height,
            width: r.width,
            clipped: element.scrollWidth > element.clientWidth + 1,
            text: element.textContent,
          };
        },
      );
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        legends,
      };
    });
    assert.ok(layout.documentWidth <= width + 1, "no horizontal page overflow");
    assert.ok(
      layout.legends.every((legend) => !legend.clipped),
      "legend values must wrap without clipping",
    );
    assert.deepEqual(errors, [], "browser runtime errors");
    await page.screenshot({
      path: path.join(output, `${width}x${height}.png`),
      fullPage: true,
    });
    report.viewports.push({
      width,
      height,
      mobile,
      status: "passed",
      controls,
      ...layout,
    });
    // Explicit failure must leave old data clearly identified and show an error.
    await page.unroute("https://push2his.eastmoney.com/**");
    await page.route(
      /https:\/\/(push2his\.eastmoney\.com|proxy\.finance\.qq\.com)\//,
      (route) => route.abort("failed"),
    );
    await page.locator("#load").click();
    await page.waitForFunction(() =>
      document.querySelector("#status").classList.contains("error"),
    );
    assert.match(await page.locator("#status").textContent(), /未使用存档替代/);
    await context.close();
  }
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.close();
}
