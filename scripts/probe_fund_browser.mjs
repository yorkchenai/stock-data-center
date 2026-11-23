// Request only through normal CORS. No remote scripts are executed.
import { chromium } from "playwright-core";

const origin = "https://yorkchenai.github.io/stock-data-center/";
const browser = await chromium.launch({
  executablePath:process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  args:["--no-sandbox"],
});
const report = {origin,checked_at:new Date().toISOString(),origin_status:null,endpoints:[]};
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console",(entry)=>{
    const message=entry.text();
    if (entry.type()==="error" && /eastmoney\.com|chinaamc\.com/.test(message)) consoleErrors.push(message.slice(0,280));
  });
  const url = await page.goto(origin,{waitUntil:"domcontentloaded",timeout:12_000});
  report.origin_status = url.status();
  if (url.ok()) report.endpoints = await page.evaluate(async () => {
    const endpoints = {
      directory:"https://fund.eastmoney.com/js/fundcode_search.js",
      history:"https://fund.eastmoney.com/pingzhongdata/000001.js",
      history_json:"https://api.fund.eastmoney.com/f10/lsjz?fundCode=000001&pageIndex=1&pageSize=2",
      official_disclosure:"https://www.chinaamc.com/fund/000001/index.shtml",
    };
    return Promise.all(Object.entries(endpoints).map(async ([name,provider])=>{
      try {
        const response=await fetch(provider,{mode:"cors",credentials:"omit",signal:AbortSignal.timeout(7_000)});
        const result = {name,status:response.ok ? "cors_readable" : "http_error",http_status:response.status};
        if (name === "official_disclosure" && response.ok) {
          const doc = new DOMParser().parseFromString(await response.text(),"text/html");
          const isNav = /^\d{4}-\d{2}-\d{2}$/;
          result.valuation_tables = [...doc.querySelectorAll("table")].flatMap((table)=>{
            const count = [...table.rows].filter((tr)=>isNav.test(tr.cells[0]?.textContent.trim())).length;
            if (!count) return [];
            return [{headers:[...(table.rows[0]?.cells ?? [])].map((c)=>c.textContent.trim()),observations:count}];
          });
        } else {
          await response.body?.cancel();
        }
        return result;
      } catch(error) { return {name,status:error.name==="TimeoutError" ? "timeout" : "cors_or_network_error"}; }
    }));
  });
  report.browser_errors=consoleErrors;
} catch(error) {
  report.origin_error=String(error.message).split("\n")[0];
} finally {
  await browser.close();
}
console.log(JSON.stringify(report,null,2));
