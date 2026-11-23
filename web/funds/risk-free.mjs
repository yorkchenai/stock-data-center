import { validDate } from "../engine.mjs";

const CALENDAR_DAY = 86_400_000;
const days = (start, end) => (Date.parse(end) - Date.parse(start)) / CALENDAR_DAY;
const conventions = new Map([["simple_act_365f", 365], ["effective_act_365f", 365], ["simple_act_360", 360]]);
const hasText = (value) => typeof value === "string" && value.trim();

export function normalizeRiskFree(raw, latestDay) {
  if (raw == null) return null;
  if (!hasText(raw.source) || validDate(raw.effective_from) > validDate(raw.effective_to)) {
    throw new Error("无风险利率缺少有效来源或覆盖区间。");
  }
  if (raw.rows == null) {
    if (!Number.isFinite(raw.annual_rate) || raw.annual_rate <= -1) throw new Error("无风险利率缺少有效年利率。");
    return {...raw, convention:"effective_trading_252"};
  }
  if (!hasText(raw.name) || !conventions.has(raw.convention) || !Number.isInteger(raw.max_age_days)
    || raw.max_age_days < 0 || raw.max_age_days > 14 || raw.effective_to > latestDay
    || !Array.isArray(raw.rows) || raw.rows.length > 24000) {
    throw new Error("历史无风险利率缺少名称、年化口径或有效区间。");
  }
  let previous = "";
  for (const row of raw.rows) {
    const date = validDate(row?.date);
    if (date <= previous || date > raw.effective_to || !Number.isFinite(row.annual_rate) || row.annual_rate <= -1) {
      throw new Error("历史无风险利率日期或数值无效。");
    }
    previous = date;
  }
  const missing = raw.missing_dates ?? [];
  if (!Array.isArray(missing) || missing.some((date, i) => validDate(date) < raw.effective_from
    || date > raw.effective_to || (i > 0 && date <= missing[i-1]))) {
    throw new Error("无风险利率缺口日期无效。");
  }
  return {...raw, missing_dates:missing};
}

export function riskFreeReturns(risk, rows, sessions) {
  if (!risk || risk.effective_from > rows[0].date || risk.effective_to < rows.at(-1).date) {
    return {reason:"缺少覆盖整个统计区间的有来源无风险利率。"};
  }
  if (risk.convention === "effective_trading_252") {
    return {values:Array(rows.length - 1).fill(Math.expm1(Math.log1p(risk.annual_rate) / sessions))};
  }
  const missing = risk.missing_dates.find((date) => rows[0].date <= date && date <= rows.at(-1).date);
  if (missing) return {reason:missing + " 缺少日历要求的历史无风险利率观察值。"};
  const basis = conventions.get(risk.convention);
  const values = [];
  let pointer = -1;
  for (let i = 1; i < rows.length; i++) {
    const start = rows[i-1].date, end = rows[i].date;
    while (risk.rows[pointer + 1]?.date <= start) pointer++;
    const quote = risk.rows[pointer];
    if (!quote || days(quote.date, start) > risk.max_age_days) {
      return {reason:start + " 缺少可用的历史无风险利率观察值或利率已过期。"};
    }
    const fraction = days(start,end) / basis;
    values.push(risk.convention === "effective_act_365f"
      ? Math.expm1(Math.log1p(quote.annual_rate) * fraction) : quote.annual_rate * fraction);
  }
  return {values};
}
