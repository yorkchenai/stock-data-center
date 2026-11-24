const options=globalThis.document?.documentElement?.dataset;
const endpoint=options?.analysisOrigin;
const ownVersion=options?.analysisModel??"local-unversioned";
export const browserModelVersion=ownVersion;
export const snapshotsEnabled=Boolean(endpoint);
const ready=new Set(["complete","partial"]);

async function request(args) {
  if (!endpoint) throw new Error("此构建未配置共享快照服务。");
  const url=new URL("/api/analysis",endpoint);
  for (const [name,value] of Object.entries(args)) {
    if (value!==null && value!==undefined && value!=="") url.searchParams.set(name,value);
  }
  const response=await fetch(url,{credentials:"omit",cache:"no-store",signal:AbortSignal.timeout(11_000)});
  const result=await response.json();
  if (!response.ok) throw new Error(result.message??`快照服务 ${result.status??response.status}。`);
  return result;
}

export async function getPageSnapshot(options, snapshotId=null) {
  let id=snapshotId;
  if (!id) {
    for (let attempt=0;attempt<7;attempt++) {
      const result=await request(options);
      if (ready.has(result.status) && result.snapshot_id) {
        id=result.snapshot_id;
        break;
      }
      if (result.status!=="building") throw new Error(result.message??"快照不可用。");
      await new Promise((resolve)=>setTimeout(resolve,3_000));
    }
  }
  if (!id) throw new Error("快照仍在构建，请稍候重试。");
  const snapshot=await request({...options,snapshot_id:id,category:"page"});
  if (snapshot.snapshot_id!==id || snapshot.asset_type!==options.asset_type ||
      snapshot.schema_version!==1 || !snapshot.model_version || snapshot.detail_status!=="available") {
    throw new Error("共享快照的编号、版本或数据无效。");
  }
  return snapshot;
}

export async function getSnapshotIndex(snapshot,indexCode) {
  const result=await request({asset_type:"fund",symbol:snapshot.symbol,snapshot_id:snapshot.snapshot_id,
    category:"index",index_code:indexCode});
  if (result.snapshot_id!==snapshot.snapshot_id || result.model_version!==snapshot.model_version ||
      result.detail_status!=="available") throw new Error("此版本快照未包含对应指数曲线。");
  return result.data;
}

export function snapshotNote(snapshot) {
  const expires=new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",dateStyle:"short",
    timeStyle:"short",hourCycle:"h23"}).format(new Date(snapshot.expires_at));
  return `共享快照 ${snapshot.snapshot_id} · ${snapshot.model_version} · 数据截至 ${snapshot.data_as_of} · 有效期至 ${expires}（上海）${snapshot.status==="partial"?" · 部分数据缺失":""}`;
}
