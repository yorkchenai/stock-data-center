import { analysisQuery, currentMarketWindow } from "./compute.mjs";
import { selectDetails, SNAPSHOT_ID, snapshotMetadata } from "./details.mjs";

const QUERY_FIELDS = new Set(["asset_type", "symbol", "start", "end", "kind", "snapshot_id", "category", "index_code"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ASSET_TYPES = new Set(["stock", "fund"]);

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
    if (snapshot.asset_type==="fund" && args.category==="page" && result.data?.fund) {
      const {risk_free,benchmark,...visibleFund}=result.data.fund;
      result.data.fund=visibleFund;
      if (benchmark) {
        const {official,name,formula,source,source_url}=benchmark;
        result.data.fund.benchmark={official,name,formula,source,source_url};
      }
      // Limit the anonymous result to fund metrics and its own curves.
      const {risk_free:rateInput,windows,...risk}=result.data.risk;
      result.data.risk={...risk,windows:Object.fromEntries(Object.entries(windows).map(([period,window])=>{
        const {comparison,points,...periodStats}=window;
        const {excess,...metrics}=periodStats.metrics;
        const {benchmark:benchmarkPoints,...fundPoints}=points??{};
        return [period,{...periodStats,metrics,points:fundPoints}];
      }))};
    }
    return result;
  }

  return {select,present:(snapshot,cache)=>check(snapshot)??{...snapshotMetadata(snapshot),cache}};
}
