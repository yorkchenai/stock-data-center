// This page exists only in a fresh test browser. The production site is not injected or updated.
const project = "https://yorkchenai.github.io/stock-data-center/";
const testPage = project + "__isolated_fund_probe__.html";
const provider = "https://fund.eastmoney.com";
const csp = [
  "default-src 'none'", "frame-src 'self' about:", "base-uri 'none'", "form-action 'none'",
  "script-src 'nonce-isolated-probe' https://fund.eastmoney.com/pingzhongdata/",
].join("; ");

export async function probeScriptIsolation(browser) {
  const context = await browser.newContext({serviceWorkers:"block"});
  const report = {origin:new URL(testPage).origin, production_page_modified:false,
    network_cache:"Playwright routing disables the browser HTTP cache",
    sequence:[],parallel:[],response_cache_headers:[]};
  try {
    await context.route("**/*",async (route)=>{
      const url = route.request().url();
      if (url === testPage) {
        await route.fulfill({contentType:"text/html; charset=utf-8",headers:{"Content-Security-Policy":csp},
          body:'<!doctype html><meta charset="utf-8"><title>Isolated probe</title><p id="sentinel">untouched</p>'});
        return;
      }
      if (url === provider + "/pingzhongdata/000000.js") return route.abort("failed");
      if (url === provider + "/pingzhongdata/999999.js") {
        await new Promise(resolve=>setTimeout(resolve,800));
        // A production response may arrive after timeout. The frame was already discarded.
        await route.fulfill({contentType:"text/javascript",body:'window.fS_code="999999";'}).catch(()=>{});
        return;
      }
      if (/^https:\/\/fund\.eastmoney\.com\/pingzhongdata\/(000001|000311|110017)\.js$/.test(url)
          && route.request().method()==="GET") return route.continue();
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.on("response",(response)=>{
      if (!response.url().startsWith(provider) || ![200,304].includes(response.status())) return;
      report.response_cache_headers.push({
        url:response.url(), status:response.status(), cache_control:response.headers()["cache-control"] ?? null,
        etag_present:Boolean(response.headers().etag),
      });
    });
    await page.goto(testPage,{waitUntil:"domcontentloaded",timeout:8_000});
    const results = await page.evaluate(async () => {
      const day = new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai"});
      const one = (code, timeout=7000) => new Promise(resolve=>{
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox","allow-scripts");
        frame.credentialless = true;
        frame.hidden=true;
        const id=crypto.randomUUID();
        const cleanup=(summary)=>{
          clearTimeout(timer);
          window.removeEventListener("message", receive);
          frame.remove();
          resolve({requested:code,...summary});
        };
        function receive(event) {
          if (event.source!==frame.contentWindow || event.origin!=="null" || event.data?.id!==id) return;
          const {code:received,history,cumulative,first,last,parent_access,failed}=event.data;
          if (failed) return cleanup({status:"load_error"});
          if (received!==code || !Number.isSafeInteger(history) || history<1
            || !Number.isSafeInteger(cumulative) || parent_access!==false) {
            return cleanup({status:"rejected_response",received:String(received).slice(0,8)});
          }
          cleanup({status:"ok",received,history,cumulative,first:day.format(new Date(first)),last:day.format(new Date(last)),parent_access});
        }
        const timer=setTimeout(()=>cleanup({status:"timeout"}),timeout);
        window.addEventListener("message",receive);
        const scriptURL="https://fund.eastmoney.com/pingzhongdata/"+code+".js";
        frame.srcdoc=`<!doctype html><meta charset="utf-8"><script nonce="isolated-probe">
          const correlation=${JSON.stringify(id)};
          const send=(fields)=>parent.postMessage({id:correlation,...fields},"*");
          const asset=document.createElement("script");
          asset.src=${JSON.stringify(scriptURL)};
          asset.onerror=()=>send({failed:true});
          asset.onload=()=>{
            let parent_access=false;
            try { parent.document.getElementById("sentinel"); parent_access=true; } catch {}
            const rows=window.Data_netWorthTrend;
            send({code:window.fS_code,history:Array.isArray(rows)?rows.length:0,
              cumulative:Array.isArray(window.Data_ACWorthTrend)?window.Data_ACWorthTrend.length:0,
              first:rows?.[0]?.x,last:rows?.at?.(-1)?.x,parent_access});
          };
          document.head.append(asset);
        <\/script>`;
        document.body.append(frame);
      });
      const sequence=[];
      for (const code of ["000001","000311","110017"]) sequence.push(await one(code));
      const failures=[await one("000000",2000),await one("999999",250)];
      const parallel=await Promise.all(["110017","000001"].map((code)=>one(code)));
      const sharedScope = await new Promise(resolve => {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.hidden = true;
        function finish(value) {
          clearTimeout(timer);
          window.removeEventListener("message", receive);
          frame.remove();
          resolve(value);
        }
        function receive(event) {
          if (event.source === frame.contentWindow && event.origin === "null" && event.data?.control === "shared") {
            finish(event.data.retained_previous_history === true);
          }
        }
        const timer = setTimeout(() => finish(null), 1500);
        window.addEventListener("message", receive);
        frame.srcdoc = `<script nonce="isolated-probe">window.fS_code="000001"; window.Data_netWorthTrend=["000001"]<\/script>
          <script nonce="isolated-probe">window.fS_code="000311";
          parent.postMessage({control:"shared",retained_previous_history:window.Data_netWorthTrend?.[0]!==window.fS_code},"*");<\/script>`;
        document.body.append(frame);
      });
      return {sequence,parallel,controlled_failures:failures,
        controlled_shared_scope_retained_old_data:sharedScope,
        parent_untouched:document.getElementById("sentinel").textContent==="untouched"
          && typeof window.fS_code==="undefined" && typeof window.Data_netWorthTrend==="undefined",
        frames_remaining:document.querySelectorAll("iframe").length};
    });
    return {...report,...results};
  } catch(error) {
    return {...report,error:String(error.message).split("\n")[0]};
  } finally {
    await context.close();
  }
}
