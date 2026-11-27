import { marketTransport } from "../snapshots/providers.mjs";
import { fundFromAssignments, readNavAssignments } from "../../web/funds/nav-source.mjs";
import { navURL } from "../../web/funds/providers.mjs";
import { fetchPublicValuation } from "../snapshots/valuation.mjs";
import { fixed, decimal, validDay } from "./ledger.mjs";

const transport = marketTransport((...args)=>fetch(...args));
const estimateOrigin = "https://yorkchenai.github.io";
const snapshots = "https://stock-data-center-voice-probe.finalnoodle2.chatgpt.site/api/analysis";

function checkedEstimate(quote, latest, day) {
  if (!quote || !latest || latest.date >= day || quote.updatedAt.slice(0,10)!==day) return null;
  // The reported daily change must use the same confirmed base as the ledger.
  const age = (Date.parse(day)-Date.parse(latest.date))/86_400_000;
  const implied = (quote.value/latest.unit_nav-1)*100;
  if (age>7 || !Number.isFinite(implied) || Math.abs(implied-quote.change)>.15) return null;
  try {
    const nav = fixed(String(quote.value),6);
    if (nav<=0n) return null;
    return {unit_nav:decimal(nav,6),change_pct:String(quote.change),updated_at:quote.updatedAt,
      source:quote.source,confidence:"平台参考估值，已核对估值日期与最近确认净值基准，最终以基金披露为准。"};
  } catch { return null; }
}

async function officialQuotes(code) {
  const text = await transport(navURL(code),{timeout:8_000});
  const fund = fundFromAssignments(readNavAssignments(text),code);
  return {name:fund.name,source:fund.source.name,
    rows:fund.rows.map(({date,unit_nav,split_factor})=>({date,unit_nav,split_factor}))};
}

async function snapshotQuotes(code,day) {
  const signal = AbortSignal.timeout(10_000);
  const query = async (args) => {
    const url = new URL(snapshots);
    url.search = new URLSearchParams({asset_type:"fund", symbol:code, ...args});
    const response = await fetch(url,{signal,redirect:"manual",headers:{Origin:estimateOrigin}});
    if (response.redirected || !response.ok || !response.body) throw new Error("Public snapshot unavailable");
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8",{fatal:true});
    let text = "", bytes = 0;
    try {
      for (;;) {
        const {done,value} = await reader.read();
        if (done) return JSON.parse(text + decoder.decode());
        bytes += value.byteLength;
        if (bytes > 3_500_000) throw new Error("Public snapshot exceeds size limit");
        text += decoder.decode(value,{stream:true});
      }
    } finally {
      void reader.cancel().catch(()=>{});
      reader.releaseLock();
    }
  };
  const ready = new Set(["complete","partial"]);
  const summary = await query({});
  const id = summary.snapshot_id;
  if (summary.schema_version!==1 || !ready.has(summary.status) ||
      typeof id!=="string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Public snapshot not ready");
  const detail = await query({snapshot_id:id,category:"page"});
  const fund = detail.data?.fund, rows = fund?.rows;
  if (detail.schema_version!==1 || detail.snapshot_id!==id || detail.symbol!==code ||
      detail.detail_status!=="available" || !ready.has(detail.status) || !(Date.parse(detail.expires_at)>Date.now()) ||
      fund?.code!==code || !Array.isArray(rows) || !rows.length || rows.length>24_000 || rows.at(-1)?.date!==detail.data_as_of ||
      rows.some((row,i)=>!validDay(row.date) || row.date>day || (i>0 && row.date<=rows[i-1].date) ||
        !Number.isFinite(row.unit_nav) || row.unit_nav<=0)) throw new Error("Public fund snapshot invalid");
  return {name:fund.name,source:fund.source?.name??"Stock Data Center 公共确认净值",
    rows:rows.map(({date,unit_nav,split_factor})=>({date,unit_nav,split_factor}))};
}

export async function portfolioMarket(code,request,ctx,day) {
  const cache = globalThis.caches?.default;
  const key = new Request(new URL(`/_portfolio_public_nav/${code}/${day}`,request.url));
  const cached = await cache?.match(key).catch(()=>null);
  let nav = cached ? await cached.json() : null;
  if (!nav) {
    nav = await officialQuotes(code).catch(()=>snapshotQuotes(code,day).catch(()=>null));
    if (nav && cache && ctx?.waitUntil)
      ctx.waitUntil(cache.put(key,Response.json(nav,{headers:{"Cache-Control":"public, max-age=300"}})).catch(()=>{}));
  }
  const latest = nav?.rows.at(-1);
  if (!latest || latest.date >= day) return nav;
  const url = new URL("/api/fund-valuation",request.url);
  url.search = new URLSearchParams({symbol:code,provider:"eastmoney"});
  const data = await fetchPublicValuation(new Request(url),estimateOrigin,ctx).then((response) =>
    response.ok ? response.json() : null).catch(()=>null);
  return {...nav,estimate:checkedEstimate(data?.values?.find((row)=>row.id==="fundgz"),latest,day)};
}
