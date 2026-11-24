// Public HTTPS requests plus an opaque-origin script adapter for CORS-restricted vendor files.
import { FUND_CODE } from "./data.mjs";
import { assignment, fundFromAssignments, NAV_FIELDS, parseDirectory, readNavAssignments } from "./nav-source.mjs";

const directoryURL="https://fund.eastmoney.com/js/fundcode_search.js";
export const navURL=(code)=>`https://fund.eastmoney.com/pingzhongdata/${code}.js`;

export async function readFundText(url, {signal, fetcher=fetch}={}) {
  const timeout=AbortSignal.timeout(12_000);
  const response=await fetcher(url,{mode:"cors",credentials:"omit",redirect:"error",cache:"no-store",
    signal:signal?AbortSignal.any([signal,timeout]):timeout});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader=response.body?.getReader();
  if (!reader) throw new Error("数据源没有返回正文。");
  let length=0;
  let text="";
  const decoder=new TextDecoder();
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) return text+decoder.decode();
      length+=value.byteLength;
      if (length>4_000_000) throw new Error("数据源响应超出限制。");
      text+=decoder.decode(value,{stream:true});
    }
  } finally {
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}

export function isolatedFundScript(url, keys, signal) {
  if (url!==directoryURL && !/^https:\/\/fund\.eastmoney\.com\/pingzhongdata\/\d{6}\.js$/.test(url)) {
    throw new Error("不支持的基金脚本地址。");
  }
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const frame=document.createElement("iframe");
    frame.sandbox="allow-scripts";
    frame.hidden=true;
    frame.credentialless=true;
    frame.referrerPolicy="no-referrer";
    const nonce=crypto.randomUUID();
    const finish=(error,value)=>{
      clearTimeout(timer);
      signal?.removeEventListener("abort",cancel);
      window.removeEventListener("message",receive);
      frame.remove();
      if (error) reject(error);
      else resolve(value);
    };
    const cancel=()=>finish(signal.reason??new DOMException("请求已取消","AbortError"));
    function receive(event) {
      if (event.source!==frame.contentWindow || event.origin!=="null" || event.data?.nonce!==nonce) return;
      const message=event.data;
      if (message.status==="ok" && message.fields && typeof message.fields==="object") finish(null,message.fields);
      else finish(new Error("基金隔离脚本未返回有效行情。"));
    }
    const timer=setTimeout(()=>finish(new Error("基金隔离脚本加载超时。")),12_000);
    signal?.addEventListener("abort",cancel,{once:true});
    window.addEventListener("message",receive);
    frame.srcdoc=`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'nonce-${nonce}' ${url}">
      <script nonce="${nonce}">
        const nonce=${JSON.stringify(nonce)}, keys=${JSON.stringify(keys)};
        const send=(status,fields)=>parent.postMessage({nonce,status,fields},"*");
        const script=document.createElement("script");
        script.src=${JSON.stringify(url)};
        script.referrerPolicy="no-referrer";
        script.onerror=()=>send("load_error");
        script.onload=()=>{
          const fields={};
          for (const key of keys) {
            const value=window[key];
            const cap=key==="r"?60000:24000;
            if (Array.isArray(value) && value.length>cap) return send("payload_too_large");
            fields[key]=value??null;
          }
          send("ok",fields);
        };
        document.head.appendChild(script);
      <\/script>`;
    document.body.append(frame);
  });
}

async function getAssignments(url, keys, parse, signal) {
  try {
    return {payload:parse(await readFundText(url,{signal})),transport:"browser-cors"};
  } catch (error) {
    if (!(error instanceof TypeError) || signal?.aborted) throw error;
    return {payload:await isolatedFundScript(url,keys,signal),transport:"isolated-script"};
  }
}

let directory;
export function fetchFundDirectory() {
  if (!directory) {
    directory=getAssignments(directoryURL,["r"],(data)=>({r:assignment(data,"r")}))
      .then(({payload})=>parseDirectory(payload.r)).catch((error)=>{directory=null;throw error;});
  }
  return directory;
}

export async function fetchFund(code, config={}, signal) {
  if (typeof code!=="string" || !FUND_CODE.test(code)) throw new Error("请输入六位场外基金代码。");
  const [raw, catalog]=await Promise.all([
    getAssignments(navURL(code),NAV_FIELDS,readNavAssignments,signal),
    fetchFundDirectory().catch(()=>null),
  ]);
  signal?.throwIfAborted();
  const fund=fundFromAssignments(raw.payload,code,{
    metadata:catalog?.get(code)??{}, evidence:config.events?.[code],
    benchmark:config.benchmarks?.[code],
  });
  fund.source.api_url=navURL(code);
  fund.source.transport=raw.transport;
  return fund;
}

export function readPageData(file, signal) {
  const url=new URL(`../${file}`,import.meta.url);
  return fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10_000)]):AbortSignal.timeout(10_000)})
    .then((response)=>{
      if (!response.ok) throw new Error(`页面数据 ${file} HTTP ${response.status}`);
      return response.json();
    });
}
