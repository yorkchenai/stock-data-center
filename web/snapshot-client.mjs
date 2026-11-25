import { resolveSymbol, validDate } from "./engine.mjs";

const options=globalThis.document?.documentElement?.dataset;
const privatePath=/^\/[a-z][a-z0-9-]*$/.test(options?.analysisPath??"") ? options.analysisPath : null;
const endpoint=privatePath
  ? new URL(privatePath,globalThis.location.origin).href
  : options?.analysisOrigin && new URL("/api/analysis",options.analysisOrigin).href;
const ownVersion=options?.analysisModel??"local-unversioned";
export const browserModelVersion=ownVersion;
export const snapshotsEnabled=Boolean(endpoint);
const ready=new Set(["complete","partial"]);
const PAGE_TIMEOUT=privatePath ? 40_000 : 11_000;

async function request(args, signal=AbortSignal.timeout(PAGE_TIMEOUT)) {
  if (!endpoint) throw new Error("此构建未配置共享快照服务。");
  const url=new URL(endpoint);
  for (const [name,value] of Object.entries(args)) {
    if (value!==null && value!==undefined && value!=="") url.searchParams.set(name,value);
  }
  const response=await fetch(url,{credentials:privatePath?"same-origin":"omit",cache:"no-store",signal});
  const result=await response.json();
  if (!response.ok) throw new Error(result.message??`快照服务 ${result.status??response.status}。`);
  return result;
}

function pause(signal) {
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const timer=setTimeout(()=>{
      signal.removeEventListener("abort",abort);
      resolve();
    },3_000);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort",abort,{once:true});
  });
}

export async function getPageSnapshot(options, snapshotId=null) {
  const signal=AbortSignal.timeout(PAGE_TIMEOUT);
  let id=snapshotId;
  if (!id) {
    for (let attempt=0;attempt<3;attempt++) {
      const result=await request(options,signal);
      if (ready.has(result.status) && result.snapshot_id) {
        id=result.snapshot_id;
        break;
      }
      if (result.status!=="building") throw new Error(result.message??"快照不可用。");
      if (attempt<2) await pause(signal);
    }
  }
  if (!id) throw new Error("快照仍在构建，请稍候重试。");
  const snapshot=await request({...options,snapshot_id:id,category:"page"},signal);
  const stock=options.asset_type==="stock" ? resolveSymbol(options.symbol,options.kind??"auto") : null;
  const symbol=stock ? stock.market+stock.code : options.symbol;
  if (snapshot.snapshot_id!==id || snapshot.asset_type!==options.asset_type ||
      snapshot.symbol!==symbol || snapshot.schema_version!==1 || !ready.has(snapshot.status) ||
      snapshot.detail_status!=="available" || !(Date.parse(snapshot.expires_at)>Date.now())) {
    throw new Error("共享快照的编号、标的、有效期或数据无效。");
  }
  if (snapshot.model_version!==ownVersion) throw new Error("共享快照与本网页模型版本不兼容。");
  validDate(snapshot.data_as_of);
  const rows=stock ? snapshot.data?.rows : snapshot.data?.fund?.rows;
  if (!Array.isArray(rows) || rows.at(-1)?.date!==snapshot.data_as_of ||
      (stock ? snapshot.data.instrument?.kind!==stock.kind : snapshot.data.fund?.code!==symbol)) {
    throw new Error("共享快照缺少对应标的的历史序列。");
  }
  if (!snapshotId && (stock && snapshot.data.validation?.unverified_missing_sessions?.some(
    (date)=>date>snapshot.data_as_of))) throw new Error("共享快照缺少末尾交易日行情。");
  return snapshot;
}

export async function getSnapshotIndex(snapshot,indexCode) {
  const result=await request({asset_type:"fund",symbol:snapshot.symbol,snapshot_id:snapshot.snapshot_id,
    category:"index",index_code:indexCode});
  if (result.snapshot_id!==snapshot.snapshot_id || result.model_version!==snapshot.model_version ||
      result.symbol!==snapshot.symbol || result.asset_type!==snapshot.asset_type ||
      result.detail_status!=="available" || result.data?.code!==indexCode) throw new Error("此版本快照未包含对应指数曲线。");
  return result.data;
}

export function snapshotNote(snapshot) {
  const expires=new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",dateStyle:"short",
    timeStyle:"short",hourCycle:"h23"}).format(new Date(snapshot.expires_at));
  return `共享快照 ${snapshot.snapshot_id} · ${snapshot.model_version} · 数据截至 ${snapshot.data_as_of} · 有效期至 ${expires}（上海）${snapshot.status==="partial"?" · 部分数据缺失":""}`;
}
