import { validDate } from "../engine.mjs";
import { normalizeBenchmark } from "./benchmark.mjs";
import { normalizeRiskFree } from "./risk-free.mjs";

export const FUND_CATEGORIES = {
  stock: "股票型", mixed: "混合型", bond: "债券型", index: "指数 / ETF 联接",
  qdii: "QDII", money: "货币型", fof: "FOF", other: "其他", unknown: "未确认",
};
export const FUND_CODE = /^\d{6}$/;
export const MAX_FILE_BYTES = 4_000_000;
const optionalText = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const validNumber = (value) => typeof value === "number" && Number.isFinite(value);
const nullablePositive = (v) => v == null || (validNumber(v) && v > 0);
const VALID_BASIS = new Set(["event_reinvested", "adjusted_nav", "unavailable"]);
export const RETURN_ISSUES = {
  missing_event_field: "来源缺少事件字段",
  unrecognized_event: "事件格式或折算比例无法核验",
  cash_after_split: "折算后缺少明确分红金额",
  cash_evidence_missing: "缺少累计净值或披露增长率，无法核验分红",
  cash_evidence_mismatch: "累计净值差额与披露增长率无法核对",
  disclosed_event_growth_mismatch: "官方事件与该日净值或披露增长率无法对账",
  growth_mismatch: "单位净值和事件与披露增长率冲突",
  invalid_multiplier: "相邻净值无法形成有效的总回报",
};
const shanghai = new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Shanghai"});

export function shanghaiToday() {
  return shanghai.format(new Date());
}

export function normalizeFund(raw) {
  if (raw?.schema_version !== 1 || raw?.kind !== "off_market_fund"
    || !FUND_CODE.test(raw.code ?? "") || typeof raw.code !== "string" || !optionalText(raw.name)) {
    throw new Error("须提供 v1 场外基金数据和六位基金代码。");
  }
  const source = raw.source;
  if (!optionalText(source?.name) || !optionalText(source?.method)
    || !optionalText(source?.retrieved_at) || !Number.isFinite(Date.parse(source.retrieved_at))) {
    throw new Error("数据缺少来源、获取时间或净值口径。");
  }
  const latestTimestamp = Date.parse(source.retrieved_at);
  const retrievalDay = shanghai.format(new Date(latestTimestamp));
  const latestDay = [retrievalDay, shanghaiToday()].sort()[0];
  if (!Array.isArray(raw.rows) || !raw.rows.length || raw.rows.length > 24000) {
    throw new Error("未找到有效的历史确认净值。");
  }
  const inception = raw.inception ? validDate(raw.inception) : null;
  const basis = raw.return_basis ?? "unavailable";
  if (!VALID_BASIS.has(basis)) throw new Error("不支持的总回报口径。");
  const rows = [];
  for (const entry of raw.rows) {
    const date = validDate(entry?.date);
    if (date > latestDay || (inception && date < inception) || (rows.length && date <= rows.at(-1).date)
      || !validNumber(entry.unit_nav) || entry.unit_nav <= 0 || !nullablePositive(entry.accumulated_nav)
      || !nullablePositive(entry.return_index) || !nullablePositive(entry.split_factor)
      || (entry.cash_distribution != null && (!validNumber(entry.cash_distribution) || entry.cash_distribution < 0))
      || (basis === "unavailable" && entry.return_index != null)) {
      throw new Error(`净值记录无效、重复或越界 ${date}。`);
    }
    rows.push({ date, unit_nav: entry.unit_nav, accumulated_nav: entry.accumulated_nav ?? null,
      return_index: entry.return_index ?? null, cash_distribution: entry.cash_distribution ?? null,
      split_factor: entry.split_factor ?? null,
      return_issue: entry.return_index == null && Object.hasOwn(RETURN_ISSUES, entry.return_issue) ? entry.return_issue : null });
  }
  if (basis !== "unavailable" && !rows.some((row) => row.return_index !== null)) {
    throw new Error("已声明总回报口径，实际缺少有效序列。");
  }
  const benchmark = normalizeBenchmark(raw.benchmark, shanghaiToday());
  const disclosure = raw.benchmark_disclosure;
  let benchmarkDisclosure = null;
  if (optionalText(disclosure?.formula)) {
    try {
      if (validDate(disclosure.effective_from) <= latestDay) benchmarkDisclosure = disclosure;
    } catch { /* Ignore invalid optional disclosure dates. */ }
  }
  const riskFree = normalizeRiskFree(raw.risk_free, shanghaiToday());
  const category = Object.hasOwn(FUND_CATEGORIES, raw.category) ? raw.category : "unknown";
  const normalFrequency = ["stock", "mixed", "bond", "index", "other"].includes(category) && raw.valuation_frequency === "daily";
  const holdings = raw.holdings;
  let disclosedHoldings = null;
  if (optionalText(holdings?.source)) {
    try {
      if (validDate(holdings.period_end) <= validDate(holdings.disclosed_at) && holdings.disclosed_at <= latestDay) {
        disclosedHoldings = holdings;
      }
    } catch { /* Ignore unsupported optional disclosures. */ }
  }
  const relatedKinds = ["official_tracking", "official_benchmark", "holdings_derived"];
  const related = Array.isArray(raw.related) ? raw.related.filter((item) =>
    relatedKinds.includes(item?.kind) && optionalText(item.name) && optionalText(item.source),
  ).slice(0, 20) : [];
  return { code: raw.code, name: raw.name.trim(), category, inception,
    manager: optionalText(raw.manager), fund_manager: optionalText(raw.fund_manager),
    size: optionalText(raw.size), fee: optionalText(raw.fee), reference: optionalText(raw.reference),
    holdings: disclosedHoldings, related, benchmark, benchmark_disclosure: benchmarkDisclosure,
    risk_free: riskFree, rows, return_basis: basis,
    return_note: optionalText(raw.return_note), source,
    normalFrequency, mode: raw.synthetic === true ? "synthetic" : "reported",
  };
}

export function fundFreshness(fund, today = shanghaiToday()) {
  if (fund.mode === "synthetic") return "测试数据";
  if (!fund.normalFrequency) return "更新频率未按日核验";
  const latest = fund.rows.at(-1).date;
  const elapsed = (Date.parse(today) - Date.parse(latest)) / 86_400_000;
  if (elapsed > 7) return "净值日期已超过 7 天";
  return "已确认披露 · 最新性待核";
}

export function searchCatalog(catalog, query) {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  return [...catalog.values()].filter((record) =>
    [record.code, record.name, record.alias].some((value) => String(value ?? "").toLowerCase().includes(term)),
  ).sort((a, b) => Number(b.code === term) - Number(a.code === term) || a.code.localeCompare(b.code)).slice(0, 16);
}
