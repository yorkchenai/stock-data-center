import { FUND_CODE, shanghaiToday } from "./data.mjs";
import { readFundText } from "./providers.mjs";
import { eastmoneyValuation, quote, sina, sinaValuation, sources, valuationTime, valuationURL } from "./valuation-source.mjs";

// Sina's endpoint has no CORS. Execute the fixed JSONP URL in an opaque sandbox, as with legacy fund NAV scripts.
function readSinaValuation(url, signal) {
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const frame = document.createElement("iframe");
    frame.sandbox = "allow-scripts";
    frame.referrerPolicy = "no-referrer";
    frame.credentialless = true;
    frame.hidden = true;
    const nonce = crypto.randomUUID();
    function finish(error,payload) {
      clearTimeout(timer);
      signal.removeEventListener("abort",cancel);
      window.removeEventListener("message",receive);
      frame.remove();
      if (error) reject(error);
      else resolve(payload);
    }
    function cancel() { finish(signal.reason); }
    function receive(event) {
      if (event.source!==frame.contentWindow || event.origin!=="null" || event.data?.nonce!==nonce) return;
      const payload = event.data.payload;
      finish(payload ? null : new Error("新浪估值加载失败"),payload);
    }
    const timer = setTimeout(()=>finish(new Error("新浪估值加载超时")),7_000);
    signal.addEventListener("abort",cancel,{once:true});
    window.addEventListener("message",receive);
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'nonce-${nonce}' ${sina}">
      <script nonce="${nonce}">
        const send=(payload)=>parent.postMessage({nonce:${JSON.stringify(nonce)},payload},"*");
        let called=false;
        window.sdcFundValuation=(payload)=>{
          if (called) return;
          called=true;
          const result=payload?.result;
          const data=result?.data;
          const rows=data?.networth;
          if (Array.isArray(rows) && rows.length>2000) return send(null);
          const scalar=(value)=>typeof value==="number" || (typeof value==="string" && value.length<=40) ? value : null;
          const pick=(row)=>Object.fromEntries(["pre_date","min_time","pre_nav","growthrate","pre_nav2","growthrate2"]
            .map((field)=>[field,scalar(row?.[field])]));
          send({result:{status:{code:scalar(result?.status?.code)},data:{
            symbol:scalar(data?.symbol ?? data?.fundcode),
            networth:Array.isArray(rows) ? rows.map(pick) : scalar(rows),
          }}});
        };
        const script=document.createElement("script");
        script.src=${JSON.stringify(url)};
        script.referrerPolicy="no-referrer";
        script.onload=()=>{if (!called) send(null);};
        script.onerror=()=>send(null);
        document.head.append(script);
      <\/script>`;
    document.body.append(frame);
  });
}

async function fetchEastmoneyValuation(code, signal) {
  const data = JSON.parse(await readFundText(valuationURL("eastmoney",code),{signal}));
  return eastmoneyValuation(data,code,valuationTime());
}

async function fetchSinaValuation(code, signal) {
  const url = valuationURL("sina",code);
  url.searchParams.set("_",String(Date.now()));
  const data = await readSinaValuation(url.href,signal);
  return sinaValuation(data,code,valuationTime());
}

const providers = [
  ["eastmoney",["fundgz"],fetchEastmoneyValuation],
  ["sina",["sina_ds2","sina_ds3"],fetchSinaValuation],
];

async function fetchProvider(provider, ids, direct, code, signal, origin) {
  if (origin) {
    try {
      const url = new URL("/api/fund-valuation",origin);
      url.search = new URLSearchParams({symbol:code,provider});
      const deadline = AbortSignal.any([signal,AbortSignal.timeout(6_000)]);
      const result = JSON.parse(await readFundText(url,{signal:deadline}));
      if (result.symbol!==code || result.provider!==provider || !Array.isArray(result.values) ||
          result.values.length>ids.length || result.values.some(({id})=>!ids.includes(id)) ||
          new Set(result.values.map(({id})=>id)).size!==result.values.length) {
        throw new Error("估值服务响应无效");
      }
      const now = valuationTime();
      return result.values.map(({id,value,change,updatedAt})=>quote(id,value,change,updatedAt,now)).filter(Boolean);
    } catch {
      signal.throwIfAborted();
    }
  }
  return direct(code,AbortSignal.any([signal,AbortSignal.timeout(7_000)]));
}

async function fetchValuation(code, signal, origin, onResult) {
  if (!FUND_CODE.test(code)) throw new Error("请输入六位基金代码");
  await Promise.all(providers.map(async ([provider,ids,direct])=>{
    let values, failed;
    try {
      values = await fetchProvider(provider,ids,direct,code,signal,origin);
      failed = [];
    } catch {
      values = [];
      failed = ids;
    }
    signal.throwIfAborted();
    onResult({ids,values,failed});
  }));
}

export function watchValuation(render, origin) {
  const cache = new Map();
  let symbols = [], controller, timer;

  function quotes(code) {
    const today = shanghaiToday()+" ";
    return (cache.get(code) ?? []).filter(({updatedAt})=>updatedAt.startsWith(today));
  }

  function pause() {
    clearTimeout(timer);
    controller?.abort();
    controller = null;
  }

  async function refreshSymbol(symbol, request) {
    const update = (message,pending)=>render(symbol,quotes(symbol),message,pending);
    update("正在更新估值…",true);
    try {
      const failed = [];
      const retained = [];
      await fetchValuation(symbol,request.signal,origin,({ids,values,failed:failures})=>{
        failed.push(...failures);
        const old = quotes(symbol);
        retained.push(...old.filter(({id})=>failures.includes(id)));
        const mixed = [...values,...old.filter(({id})=>!ids.includes(id) || failures.includes(id))];
        cache.set(symbol,Object.keys(sources).flatMap((id)=>mixed.filter((item)=>item.id===id)));
        update("正在更新估值…",true);
      });
      if (controller!==request) return;
      const failure = failed.length===Object.keys(sources).length ? "更新失败" : failed.length ? "部分估值来源更新失败" : "";
      const message = retained.length ? failure+" · 保留上次成功估值" : failure;
      update(message,false);
    } catch {
      if (controller!==request) return;
      update(quotes(symbol).length ? "更新失败 · 保留上次成功估值" : "更新失败",false);
    }
  }

  async function refresh() {
    if (!symbols.length || document.hidden || controller) return;
    clearTimeout(timer);
    const request = controller = new AbortController();
    const started = Date.now();
    const batch = symbols;
    try {
      // Fetch at most three funds at once, even when the watchlist has many rows.
      for (let i=0; i<batch.length && controller===request; i+=3) {
        await Promise.all(batch.slice(i,i+3).map((symbol)=>refreshSymbol(symbol,request)));
      }
    } finally {
      if (controller===request) {
        controller = null;
        timer = setTimeout(refresh,Math.max(0,60_000-(Date.now()-started)));
      }
    }
  }

  document.addEventListener("visibilitychange",()=>{
    if (document.hidden) pause();
    else void refresh();
  });
  return {refresh,quotes,select(codes) {
    const next = [...new Set(codes)].sort();
    if (next.length===symbols.length && next.every((symbol,index)=>symbol===symbols[index])) return;
    pause();
    symbols = next;
    void refresh();
  }};
}
