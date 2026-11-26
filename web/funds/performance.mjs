import { validDate } from "../engine.mjs";
import { RETURN_ISSUES } from "./data.mjs";

export const PERIODS = [["1w","近1周"],["1m","近1月"],["3m","近3月"],["6m","近6月"],
  ["1y","近1年"],["3y","近3年"],["5y","近5年"]];
const SESSIONS = 252;
const ANNUAL_REFERENCE = 0.025;
export const FUND_RISK_REFERENCE = Object.freeze({
  annual_rate:ANNUAL_REFERENCE, observations_per_year:SESSIONS,
  daily_rate:(1+ANNUAL_REFERENCE)**(1/SESSIONS)-1,
});
const DAY = 86_400_000;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const result = (value, reason = null) => Number.isFinite(value) ? {value, reason: null} : {value: null, reason};
const fail = (reason) => result(null, reason);
function sampleDeviation(values) {
  const shifted = values.map((value) => value - values[0]);
  const center = mean(shifted);
  return Math.sqrt(shifted.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}

export function periodStart(end, key) {
  validDate(end);
  const date = new Date(end + "T00:00:00Z");
  if (key === "1w") return new Date(date.getTime() - 7 * DAY).toISOString().slice(0, 10);
  const months = {"1m":1, "3m":3, "6m":6, "1y":12, "3y":36, "5y":60}[key];
  if (!months) throw new Error("未知统计区间。");
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString().slice(0, 10);
}

export function selectWindow(fund, start, end) {
  if (start) validDate(start);
  validDate(end);
  if (start && start > end) return {error:"开始日期不能晚于结束日期。", rows:[]};
  const first = fund.rows[0].date;
  if ((start && start < first) || (fund.inception && end < fund.inception)) {
    return {error:"成立时间或历史覆盖不足。", rows:[]};
  }
  const from = start ? fund.rows.findLastIndex((row) => row.date <= start) : 0;
  const through = fund.rows.findLastIndex((row) => row.date <= end);
  if (from < 0 || through < from) return {error:"统计区间内没有有效净值。", rows:[]};
  return {rows:fund.rows.slice(from, through + 1), start:fund.rows[from].date, end:fund.rows[through].date};
}

export function periodReturn(fund, key) {
  const end = fund.rows.at(-1).date;
  const start = periodStart(end, key);
  const selected = selectWindow(fund, start, end);
  if (selected.error) return fail(selected.error);
  if ((Date.parse(start) - Date.parse(selected.start)) / DAY > (key === "1w" ? 7 : 14)) {
    return fail("周期起点附近缺少净值记录。");
  }
  return totalReturn(selected.rows);
}

function totalReturn(rows) {
  if (rows.length < 2) return fail("不足两条净值记录。");
  const gap = rows.find((row) => row.return_index === null);
  if (gap) {
    const issue = Object.hasOwn(RETURN_ISSUES, gap.return_issue) ? RETURN_ISSUES[gap.return_issue] : null;
    return fail(issue ? `${gap.date} ${issue}。` : "缺少连续的分红再投资总回报序列。");
  }
  return result(rows.at(-1).return_index / rows[0].return_index - 1);
}

export function analyzePerformance(fund, window) {
  const {rows, start, end} = window;
  const period = window.error ? fail(window.error) : totalReturn(rows);
  const missing = fail(period.reason);
  const metrics = {return:period, annualReturn:missing, drawdown:missing, volatility:missing,
    sharpe:missing, sortino:missing, calmar:missing,
    drawdownDays:missing, recoveryDays:missing};
  const points = {fund:[], drawdown:[]};
  if (period.value === null) return {metrics, points};

  const first = rows[0].return_index;
  let peak = first, peakDate = start, worst = 0, worstPeakDate = start, trough = start, recovery = null, worstPeak = first;
  const returns = [];
  const dayDiff = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;
  rows.forEach(({date, return_index: value}, i) => {
    points.fund.push({time:date, value:value / first - 1});
    if (value >= peak) { peak = value; peakDate = date; }
    const current = value / peak - 1;
    points.drawdown.push({time:date, value:current});
    if (current < worst) {
      worst = current; worstPeak = peak; worstPeakDate = peakDate; trough = date; recovery = null;
    } else if (!recovery && worst < 0 && date > trough && value >= worstPeak) {
      recovery = date;
    }
    if (i) returns.push(value / rows[i - 1].return_index - 1);
  });
  const days = dayDiff(start, end);
  metrics.annualReturn = result((1 + period.value) ** (365.2425 / days) - 1, "年化结果超出可计算范围。");
  metrics.drawdown = result(worst);
  metrics.drawdownDays = result(dayDiff(worstPeakDate, trough));
  metrics.recoveryDays = !worst ? result(0) : recovery ? result(dayDiff(trough, recovery)) : fail("区间结束时尚未恢复。");
  metrics.calmar = worst && metrics.annualReturn.value !== null
    ? result(metrics.annualReturn.value / -worst) : fail("区间没有回撤或缺少年化收益。");

  const longGap = rows.some((row,i)=>i>0 && dayDiff(rows[i-1].date,row.date)>14);
  if (returns.some((value)=>!Number.isFinite(value))) {
    metrics.volatility = metrics.sharpe = metrics.sortino = fail("日收益数据异常。");
  } else if (!fund.normalFrequency || returns.length < 2 || longGap) {
    const reason = fail(!fund.normalFrequency ? "该基金类型或估值频率尚未采用同一日频年化口径。"
      : longGap ? "观察记录相隔超过 14 天，无法按日频年化。" : "至少需要两个日收益样本。");
    metrics.volatility = metrics.sharpe = metrics.sortino = reason;
  } else {
    const sigma = sampleDeviation(returns);
    metrics.volatility = result(sigma * Math.sqrt(SESSIONS),"日收益波动率超出可计算范围。");
    const relativeReturns = returns.map((value)=>value-FUND_RISK_REFERENCE.daily_rate);
    const scaledMean = mean(relativeReturns)*Math.sqrt(SESSIONS);
    // Subtracting a constant leaves the sample standard deviation unchanged.
    metrics.sharpe = !Number.isFinite(sigma) ? fail("日收益波动率超出可计算范围。") : sigma
      ? result(scaledMean/sigma,"夏普比率超出可计算范围。") : fail("日收益样本波动率为零。");
    // Include all observations. Days at or above the reference contribute zero to downside deviation.
    const downside = Math.sqrt(mean(relativeReturns.map((value)=>Math.min(value,0)**2)));
    metrics.sortino = !Number.isFinite(downside) ? fail("日收益下行偏差超出可计算范围。") : downside
      ? result(scaledMean/downside,"索提诺比率超出可计算范围。") : fail("相对参考收益率的下行偏差为零。");
  }

  return {metrics, points};
}
