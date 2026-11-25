import { validDate } from "../engine.mjs";
import { normalizeFund, RETURN_ISSUES, shanghaiToday } from "./data.mjs";

export const BUNDLE_BYTES = 16_000_000;
export const AVERAGES = ["MA5", "MA10", "MA20", "MA60"];
export const VOLUMES = ["volume", "VOL5", "VOL10"];
const PRICE = ["open", "high", "low", "close", ...AVERAGES];
const INDEX_CODE = /^[0-9A-Z]{6}$/;
const QUALITY = new Set(["strong", "moderate"]);
const EVIDENCE = new Set(["direct_support", "unverified", "conflict", "insufficient"]);
const VOLUME_UNITS = new Set(["股", "手", "份"]);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const bounded = (value, low, high) => finite(value) && low <= value && value <= high;
export const dayAge = (day) => day ? Math.max(0, (Date.parse(shanghaiToday()) - Date.parse(day)) / 86400000) : null;

export function navTimeline(fund, mode) {
  if (!fund) return {segments: [], gaps: [], points: []};
  const segments = [], gaps = [], points = [];
  let active, anchor;
  for (const row of fund.rows) {
    if (mode === "adjusted" && row.return_index == null) {
      gaps.push({date:row.date, reason:RETURN_ISSUES[row.return_issue] ?? "无可核验的复权值"});
      points.push({time:row.date});
      active = null;
      continue;
    }
    if (!active) {
      anchor = row;
      active = {anchor:row.date, points:[]};
      segments.push(active);
    }
    const value = mode === "raw" ? row.unit_nav : anchor.unit_nav * (row.return_index / anchor.return_index);
    // A non-finite vendor result must remain a visual gap.
    if (!finite(value)) throw new Error("复权净值超出可显示范围。");
    const point = {time:row.date, value};
    active.points.push(point);
    points.push(point);
  }
  return {segments, gaps, points};
}

function sourceLink(value) {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const link = new URL(value);
  return link.protocol === "https:" && !link.username && !link.password ? link.href : null;
}

export function normalizeAssociations(raw, fundCode) {
  if (raw?.schema_version !== 1 || raw?.kind !== "fund_sector_analysis" || raw.fund_code !== fundCode
      || !Array.isArray(raw.sectors) || raw.sectors.length > 5 || !Number.isFinite(Date.parse(raw.computed_at))) {
    throw new Error("关联分析缺少有效版本、基金代码或计算时间。");
  }
  const fundDay = validDate(raw.fund_as_of);
  const modelDay = raw.model_as_of ? validDate(raw.model_as_of) : null;
  if (fundDay > shanghaiToday() || (modelDay && modelDay > fundDay) || (raw.sectors.length && !modelDay)) {
    throw new Error("关联分析的净值或模型日期无效。");
  }
  const distinct = new Set();
  const sectors = raw.sectors.map((item, i) => {
    if (typeof item?.code !== "string" || !INDEX_CODE.test(item.code) || distinct.has(item.code) || item.rank !== i+1
        || typeof item.name !== "string" || !item.name.trim() || !QUALITY.has(item.quality)
        || !finite(item.beta) || !bounded(item.stability, 0, 1) || !EVIDENCE.has(item.holdings?.status)) {
      throw new Error("关联分析包含无效的指数、排名或持仓证据。");
    }
    const windows = {};
    for (const days of [60,120]) {
      const stat = item.windows?.[days];
      if (!bounded(stat?.pearson, -1, 1) || !bounded(stat.partial, -1, 1)
          || stat.count !== days || stat.partial_count !== days) {
        throw new Error("关联分析缺少经验证的相关窗口。");
      }
      windows[days] = {pearson:stat.pearson, partial:stat.partial, count:stat.count};
    }
    const holdings = item.holdings;
    if (holdings.status === "direct_support"
        && (!sourceLink(holdings.source) || !bounded(holdings.weight_pct_nav, 0, 100))) {
      throw new Error("直接持仓支持缺少比例或来源。");
    }
    const indexDay = validDate(item.index_as_of);
    if (indexDay > shanghaiToday() || indexDay < modelDay) throw new Error("指数截止日期无效。");
    distinct.add(item.code);
    return {...item, index_as_of:indexDay, windows,
      holdings:{...holdings, source:sourceLink(holdings.source)}};
  });
  return {...raw, fund_as_of:fundDay, model_as_of:modelDay, sectors};
}

export function normalizeIndex(raw, fundCode, entry, modelDay) {
  if (raw?.schema_version !== 1 || raw?.kind !== "fund_sector_history" || raw.fund_code !== fundCode
      || raw.code !== entry.code || raw.name !== entry.name || raw.model_as_of !== modelDay
      || raw.basis !== "price" || raw.currency !== "CNY"
      || !sourceLink(raw.source?.url) || typeof raw.source?.name !== "string"
      || !Array.isArray(raw.rows) || !raw.rows.length || raw.rows.length > 5000) {
    throw new Error("指数数据与当前基金、板块或模型日期不一致。");
  }
  const volumeUnit = VOLUME_UNITS.has(raw.volume_unit) ? raw.volume_unit : null;
  const modelIndexDay = validDate(raw.model_index_as_of ?? raw.last);
  let prior = "";
  let validVolumeDays = 0;
  const data = raw.rows.map((row) => {
    const date = validDate(row.date);
    if (date <= prior || date > shanghaiToday()) throw new Error("指数行情日期重复、乱序或越界。");
    prior = date;
    const values = {date};
    for (const key of PRICE) {
      if (row[key] != null && (!finite(row[key]) || row[key] <= 0)) throw new Error("指数价格或均线数值无效。");
      values[key] = row[key] ?? null;
    }
    const prices = ["open","high","low"].map((key)=>values[key]);
    if (prices.some((v)=>v !== null) && (prices.some((v)=>v === null) || values.close === null
        || values.low > Math.min(values.open, values.close) || values.high < Math.max(values.open, values.close))) {
      throw new Error("指数开高低收不符合校验条件。");
    }
    values.volume = volumeUnit && values.close !== null && finite(row.volume) && row.volume >= 0 ? row.volume : null;
    validVolumeDays = values.volume === null ? 0 : validVolumeDays + 1;
    values.VOL5 = validVolumeDays >= 5 && finite(row.VOL5) && row.VOL5 >= 0 ? row.VOL5 : null;
    values.VOL10 = validVolumeDays >= 10 && finite(row.VOL10) && row.VOL10 >= 0 ? row.VOL10 : null;
    return values;
  });
  const observed = data.filter((row)=>row.close !== null);
  if (!observed.length || observed[0].date !== raw.first || observed.at(-1).date !== raw.last
      || modelIndexDay !== entry.index_as_of) throw new Error("指数实际走势与覆盖日期不一致。");
  return {...raw, rows:data, model_index_as_of:modelIndexDay, volume_unit:volumeUnit,
    source:{...raw.source,url:sourceLink(raw.source.url),volume_unit_evidence:sourceLink(raw.source.volume_unit_evidence)}};
}

export function normalizeChartFile(raw) {
  if (raw?.kind !== "fund_chart_bundle") return {fund:normalizeFund(raw), bundle:null};
  if (raw.schema_version !== 1) throw new Error("不支持的数据包版本。");
  const fund = normalizeFund(raw.fund);
  const analysis = normalizeAssociations(raw.analysis,fund.code);
  if (analysis.fund_as_of > fund.rows.at(-1).date || !Array.isArray(raw.indices)
      || raw.indices.length !== analysis.sectors.length) throw new Error("数据包中的基金与板块日期或数量不一致。");
  const indexes = new Map();
  for (const rawIndex of raw.indices) {
    const entry = analysis.sectors.find((item)=>item.code === rawIndex.code);
    if (!entry || indexes.has(entry.code)) throw new Error("数据包含未知或重复指数。");
    indexes.set(entry.code,normalizeIndex(rawIndex,fund.code,entry,analysis.model_as_of));
  }
  return {fund,bundle:{analysis,indexes}};
}

export function indexCapabilities(rows, volumeUnit) {
  const observed = rows.filter((row)=>row.close !== null);
  return {candles:observed.length>0 && observed.every((row)=>row.open !== null),
    volume:Boolean(volumeUnit && rows.some((row)=>row.volume !== null))};
}
