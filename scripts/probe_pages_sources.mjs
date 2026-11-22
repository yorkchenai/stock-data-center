// Live feasibility probe. Run against a deployed Pages URL with PAGES_URL, or
// a locally served build with PAGES_URL=http://127.0.0.1:8765/stock-data-center/.
import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const output = process.env.PROBE_OUTPUT || "work/pages-live";
await mkdir(output, { recursive: true });
const url = process.env.PAGES_URL;
if (!url)
  throw new Error("PAGES_URL must name the actual page/origin being tested");
const report = {
  at: new Date().toISOString(),
  requested_url: url,
  tests: [],
  symbols: [],
  browser_errors: [],
};
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  page.on("requestfailed", (request) =>
    report.browser_errors.push({
      url: request.url(),
      error: request.failure()?.errorText,
    }),
  );
  const response = await page.goto(url, { timeout: 30000 });
  if (!response?.ok()) throw new Error(`Probe page HTTP ${response?.status()}`);
  report.actual_url = page.url();
  report.origin = new URL(page.url()).origin;
  await page.locator("#history-label").filter({ hasText: "1,551" }).waitFor();
  const end = process.env.PROBE_END || "2026-11-20";
  for (const symbol of ["000688", "600519", "399006", "sh000001"]) {
    const result = await page.evaluate(
      async ({ symbol, end }) => {
        const { fetchHistory } = await import("./providers.mjs");
        const calendar = await (
          await fetch("./calendar.json", { cache: "no-store" })
        ).json();
        try {
          return {
            status: "success",
            dataset: await fetchHistory(
              { symbol, kind: "auto", start: "2020-07-01", end },
              calendar,
            ),
          };
        } catch (error) {
          return { status: "failed", error: error.message };
        }
      },
      { symbol, end },
    );
    report.symbols.push({
      symbol,
      status: result.status,
      source: result.dataset?.source,
      rows: result.dataset?.rows.length,
      attempts: result.dataset?.attempts,
      error: result.error,
    });
    await writeFile(
      path.join(output, `${symbol}.json`),
      JSON.stringify(result, null, 2),
    );
    await page.waitForTimeout(1000);
  }
  for (const [source, base] of [
    [
      "eastmoney",
      "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000688&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=0&beg=20200701&end=" +
        end.replaceAll("-", ""),
    ],
    [
      "tencent-proxy",
      "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=sh000688,day,2020-01-01,2021-12-31,640,",
    ],
    [
      "tencent-web",
      "https://web.ifzq.gtimg.cn/appstock/app/newfqkline/get?param=sh000688,day,2020-01-01,2021-12-31,640,",
    ],
  ]) {
    for (const mode of ["cors", "jsonp/script"]) {
      const result = await page.evaluate(
        async ({ base, mode, source }) => {
          if (mode === "cors") {
            try {
              const response = await fetch(base, {
                mode: "cors",
                credentials: "omit",
                cache: "no-store",
                signal: AbortSignal.timeout(25000),
              });
              const payload = await response.json();
              return {
                ok: response.ok,
                status: response.status,
                records:
                  payload.data?.klines?.length ??
                  payload.data?.sh000688?.day?.length ??
                  0,
              };
            } catch (error) {
              return { ok: false, error: error.message };
            }
          }
          return new Promise((resolve) => {
            const name = "source_probe_" + Math.random().toString(36).slice(2),
              script = document.createElement("script");
            const finish = (result) => {
              clearTimeout(timer);
              script.remove();
              delete window[name];
              resolve(result);
            };
            const timer = setTimeout(
              () => finish({ ok: false, error: "script timeout" }),
              25000,
            );
            let payload;
            window[name] = (result) => {
              payload = result;
            };
            const url = new URL(base);
            url.searchParams.set(source === "eastmoney" ? "cb" : "_var", name);
            script.src = url.href;
            script.onload = () => {
              payload ||= window[name];
              finish({
                ok: typeof payload === "object",
                records:
                  payload?.data?.klines?.length ??
                  payload?.data?.sh000688?.day?.length ??
                  0,
              });
            };
            script.onerror = () =>
              finish({
                ok: false,
                error: "script load error (network, MIME or browser policy)",
              });
            document.head.append(script);
          });
        },
        { base, mode, source },
      );
      report.tests.push({ source, mode, ...result });
      await page.waitForTimeout(1000);
    }
  }
} catch (error) {
  report.fatal = error.message;
} finally {
  await writeFile(
    path.join(output, "probe.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
if (
  report.fatal ||
  report.symbols.length !== 4 ||
  report.symbols.some((s) => s.status !== "success")
)
  process.exitCode = 1;
