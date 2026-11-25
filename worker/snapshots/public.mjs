import { analysisQuery, currentMarketWindow } from "./compute.mjs";
import { selectDetails, SNAPSHOT_ID, snapshotMetadata } from "./details.mjs";

const QUERY_FIELDS = new Set(["asset_type", "symbol", "start", "end", "kind", "snapshot_id", "category", "index_code"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ASSET_TYPES = new Set(["stock", "fund"]);
const BUILD_SLOT = "public_build_active";

export function publicError(status, message, extra = {}) {
  return {schema_version:1, status, ...(message ? {message} : {}), ...extra};
}

export function publicOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" ||
      url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch { return false; }
}

export function publicQuery(url, params, calendar, now) {
  if ([...url.searchParams].length !== Object.keys(params).length ||
      Object.keys(params).some((name) => !QUERY_FIELDS.has(name))) throw new Error("查询参数无效。");
  const {asset_type, symbol, kind, start, end, snapshot_id, category, index_code} = params;
  if (!ASSET_TYPES.has(asset_type) || !/^(?:sh|sz)?\d{6}$/i.test(symbol ?? "") ||
      (kind !== undefined && !["auto", "stock", "index"].includes(kind)) ||
      [start, end].some((value) => value !== undefined && !DATE.test(value))) throw new Error("标的或日期无效。");
  if (asset_type === "fund" && (!/^\d{6}$/.test(symbol) || kind !== undefined || start !== undefined || end !== undefined)) {
    throw new Error("请输入六位基金代码。");
  }
  if (snapshot_id !== undefined) {
    if (!SNAPSHOT_ID.test(snapshot_id) || !["page", "index"].includes(category) ||
        (category === "index" ? asset_type !== "fund" || !/^[0-9A-Z]{6}$/.test(index_code ?? "") : index_code !== undefined)) {
      throw new Error("只支持读取指定快照的网页或关联指数视图。");
    }
    return;
  }
  if (category !== undefined || index_code !== undefined) throw new Error("查询详情需要指定快照编号。");
  if (asset_type === "stock" && analysisQuery(params, calendar, now).end !== currentMarketWindow(calendar, now).end) {
    throw new Error("公开入口只按需构建最近完整交易日快照。更早的日期可用网页独立查询。");
  }
}

export function publicPresentation(version) {
  const check = (snapshot) => snapshot.model_version !== version
    ? publicError("version_mismatch", "该快照的模型版本已更新，请重新查询。") : null;

  function select(snapshot, args) {
    const blocked=check(snapshot);
    if (blocked) return blocked;
    const result=selectDetails(snapshot,args,{browser:true});
    // Supplemental risk-free and benchmark histories remain outside anonymous page responses.
    // Removing source-based display grants does not expand the public response schema.
    if (snapshot.asset_type==="fund" && args.category==="page" && result.data?.fund) {
      const {risk_free,benchmark,...visibleFund}=result.data.fund;
      result.data.fund=visibleFund;
    }
    return result;
  }

  return {select,present:(snapshot,cache)=>check(snapshot)??{...snapshotMetadata(snapshot),cache}};
}

export async function admitPublicBuild(store, now, takeBudget) {
  const token = await store.lease(BUILD_SLOT, now);
  if (!token) return publicError("rate_limited", "公开快照构建队列繁忙，请稍后再试。", {retry_after_seconds:15});
  const release = () => store.release(BUILD_SLOT, token);
  try {
    const status = await takeBudget();
    if (!status) return release;
    await release();
    return publicError(status, "公开快照构建额度暂不可用。", {retry_after_seconds:60});
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
}
