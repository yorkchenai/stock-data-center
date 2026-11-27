import { calculateIndicators, normalizeDaily, validDate } from "./engine.mjs";

const minute = 60_000;
const day = 86_400_000;
const offset = 8 * 60 * minute;
const sessions = [[570, 690], [780, 900]];

export function shanghaiDate(now = Date.now()) {
  return new Date(now + offset).toISOString().slice(0, 10);
}

function localMidnight(date) {
  return Date.parse(date + "T00:00:00Z") - offset;
}

export function marketClock(calendar, now = Date.now()) {
  const date = shanghaiDate(now);
  if (!calendar?.sessions || date < calendar.start || date > calendar.end)
    return { phase: "unknown", date, dataDate: null, next: null };
  const today = calendar.sessions.includes(date);
  const lastDay = calendar.sessions.findLast((session) => session < date);
  const future = calendar.sessions.find((session) => session > date);
  const nextOpen = future ? localMidnight(future) + sessions[0][0] * minute : null;
  const midnight = localMidnight(date);
  const minutes = (now - midnight) / minute;
  if (!today) return { phase: "closed-day", date, dataDate: lastDay, next: nextOpen };
  if (minutes < sessions[0][0])
    return { phase: "preopen", date, dataDate: lastDay, next: midnight + sessions[0][0] * minute };
  for (const [start, end] of sessions) {
    if (minutes >= start && minutes < end)
      return { phase: "trading", date, dataDate: date, next: midnight + end * minute };
  }
  if (minutes < sessions[1][0])
    return { phase: "break", date, dataDate: date, next: midnight + sessions[1][0] * minute };
  return { phase: "closed", date, dataDate: date, next: nextOpen };
}

export function nextMinuteRefresh(clock, now) {
  if (clock.phase === "trading") return Math.min(30_000, clock.next - now);
  return clock.next === null ? null : Math.min(day, clock.next - now);
}

function periodKey(date, period) {
  if (period === "month") return date.slice(0, 7) + "-01";
  const value = new Date(date + "T00:00:00Z");
  value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7);
  return value.toISOString().slice(0, 10);
}

function periodEnd(key, period) {
  const date = new Date(key + "T00:00:00Z");
  if (period === "month") date.setUTCMonth(date.getUTCMonth() + 1, 0);
  else date.setUTCDate(date.getUTCDate() + 6);
  return date.toISOString().slice(0, 10);
}

export function aggregatePeriods(input, period, { calendar, instrument, now = Date.now() } = {}) {
  if (!["week", "month"].includes(period)) throw new Error("无效的行情周期");
  const rows = normalizeDaily(input);
  const groups = new Map();
  for (const row of rows) {
    const key = periodKey(row.date, period);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const expected = new Map();
  for (const session of calendar?.sessions ?? []) {
    const key = periodKey(session, period);
    if (!groups.has(key)) continue;
    if (!expected.has(key)) expected.set(key, []);
    expected.get(key).push(session);
  }
  const suspensions = (calendar?.suspensions ?? []).filter((entry) =>
    entry.symbol === (instrument?.market ?? "") + (instrument?.code ?? "") &&
    entry.kind === instrument?.kind);
  const today = shanghaiDate(now);
  const cutoff = localMidnight(today) + (15 * 60 + 35) * minute;
  const bars = [];
  for (const [key, values] of groups) {
    const first = values[0], last = values.at(-1), end = periodEnd(key, period);
    const scheduled = expected.get(key);
    const covered = scheduled?.length && calendar.start <= key && calendar.end >= end;
    const finalSession = covered ? scheduled.at(-1) : end;
    const forming = key === periodKey(today, period) &&
      (today < finalSession || (today === finalSession && now < cutoff));
    const actual = new Set(values.map((row) => row.date));
    const missing = covered ? scheduled.filter((date) => !actual.has(date) &&
      !suspensions.some((entry) => date >= entry.start && date <= entry.end)) : [];
    bars.push({
      date: last.date, period_start: first.date, period_end: last.date,
      period_state: forming ? "forming" : !covered ? "unverified" : missing.length ? "incomplete" : "complete",
      open: first.open, close: last.close,
      high: Math.max(...values.map((row) => row.high)),
      low: Math.min(...values.map((row) => row.low)),
      volume_lots: values.reduce((total, row) => total + row.volume_lots, 0),
      turnover_cny: values.reduce((total, row) => total + row.turnover_cny, 0),
    });
  }
  return calculateIndicators(bars).map((row, i) => ({
    ...row, period_start: bars[i].period_start, period_end: bars[i].period_end,
    period_state: bars[i].period_state,
  }));
}

export function minuteURL(instrument) {
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/trends2/get");
  url.search = new URLSearchParams({
    secid: (instrument.market === "sh" ? "1." : "0.") + instrument.code,
    fields1: "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58",
    ndays: "1", iscr: "0", iscca: "0",
  });
  return url.href;
}

function exactNumber(value) {
  return value == null || String(value).trim() === "" ? NaN : Number(value);
}

function calculateMinuteSegment(rows, previousClose) {
  // The shared engine checks unique, weekday ISO dates before calculating by
  // sequence. Use internal weekday keys for minutes and discard those keys.
  // No timestamps, observations or prices are added to the plotted data.
  const keys = rows.map((row, i) => ({
    ...row, date: new Date(Date.UTC(2000, 0, 3 + i + 2 * Math.floor(i / 5))).toISOString().slice(0, 10),
  }));
  const calculated = calculateIndicators(keys);
  return calculated.map((row, i) => ({
    ...row, ...rows[i],
    change_pct: Number.isFinite(previousClose) && previousClose > 0
      ? (row.close / previousClose - 1) * 100 : null,
    // The EMA seed is computable early but 26 minutes are needed for the
    // long EMA and nine differences for its signal before we display MACD.
    DIF: i < 33 ? null : row.DIF, DEA: i < 33 ? null : row.DEA,
    MACD_hist: i < 33 ? null : row.MACD_hist,
  }));
}

function sessionPosition(row) {
  const [hour, minuteLabel] = row.label.split(":").map(Number);
  const slot = hour * 60 + minuteLabel;
  const [morning, afternoon] = sessions;
  return slot < afternoon[0] ? slot - morning[0] : morning[1] - morning[0] + slot - afternoon[0];
}

function minuteIndicators(rows, previousClose) {
  const segments = [[]];
  for (const row of rows) {
    const last = segments.at(-1).at(-1);
    if (last && sessionPosition(row) - sessionPosition(last) > 1) segments.push([]);
    segments.at(-1).push(row);
  }
  return segments.flatMap((segment) => calculateMinuteSegment(segment, previousClose));
}

export function parseMinutes(payload, instrument, date, now = Date.now()) {
  validDate(date);
  const data = payload?.data;
  if (data?.code !== instrument.code || data.market !== (instrument.market === "sh" ? 1 : 0))
    throw new Error("东方财富返回的分时市场、代码不匹配或标的不存在");
  if (!Array.isArray(data.trends) || !data.trends.length) throw new Error("未取得分时记录");
  if (data.trends.length > 242) throw new Error("分时记录超过单日范围");
  const seen = new Set();
  const rows = data.trends.map((line) => {
    if (typeof line !== "string") throw new Error("分时记录格式异常");
    const [stamp, ...fields] = line.split(",");
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stamp) || fields.length !== 7)
      throw new Error("分时字段或时间格式异常");
    if (stamp.slice(0, 10) !== date) throw new Error(`来源尚未返回 ${date} 的分时行情`);
    const label = stamp.slice(11), [h, m] = label.split(":").map(Number);
    const slot = h * 60 + m;
    const time = (localMidnight(date) + slot * minute) / 1000;
    if (m >= 60 || !sessions.some(([start, end]) => slot >= start && slot <= end) ||
        seen.has(slot) || time * 1000 > Math.floor(now / minute) * minute + minute)
      throw new Error("分时记录有重复或处于非交易时段");
    seen.add(slot);
    const [open, close, high, low, volume_lots, turnover_cny, average] = fields.map(exactNumber);
    if (![open, close, high, low, volume_lots, turnover_cny].every(Number.isFinite) ||
        low <= 0 || low > Math.min(open, close) || high < Math.max(open, close) ||
        volume_lots < 0 || turnover_cny < 0)
      throw new Error("分时价格、成交量或成交额异常");
    return {
      date, time, label, open, close, high, low, volume_lots, turnover_cny,
      average: Number.isFinite(average) && average > 0 ? average : null,
    };
  }).sort((a, b) => a.time - b.time);
  const latest = rows.at(-1).time * 1000;
  const until = Math.min(now, localMidnight(date) + sessions.at(-1)[1] * minute);
  const missing = sessions.reduce((count, [start, end]) => {
    // The 09:30 opening observation and 13:00 reference tick may be present;
    // only require actual one-minute end labels, e.g. 13:01 through 15:00.
    for (let slot = start + 1; slot <= end && localMidnight(date) + slot * minute <= until; slot++)
      if (!seen.has(slot)) count++;
    return count;
  }, 0);
  const sourceTime = exactNumber(data.time) * 1000;
  return {
    rows: minuteIndicators(rows, exactNumber(data.preClose)),
    received: now,
    sourceTime: Number.isFinite(sourceTime) && sourceTime > 0 && sourceTime <= now + minute ? sourceTime : null,
    latest, missing,
  };
}

export function minuteFreshness(result, clock, now = Date.now()) {
  if (clock.phase !== "trading") return "非交易时段 · 自动刷新暂停";
  const midnight = localMidnight(clock.date);
  const position = (now - midnight) / minute;
  const session = sessions.find(([start, end]) => position >= start && position < end);
  if (!session) return "非交易时段 · 自动刷新暂停";
  const elapsed = now - midnight - session[0] * minute;
  const lag = result.rows[0].date === clock.date
    ? Math.max(0, Math.min(elapsed, now - result.latest)) : Math.max(0, elapsed);
  const sourceLag = result.sourceTime === null ? 0 : now - result.sourceTime;
  if (lag >= 90_000 || sourceLag >= 90_000)
    return `行情有延迟（至少约 ${Math.floor(Math.max(lag, sourceLag) / 1000)} 秒）`;
  return "实时等级未核实";
}

export async function fetchMinutes(instrument, date, signal) {
  const response = await fetch(minuteURL(instrument), {
    mode: "cors", credentials: "omit", cache: "no-store", redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(12_000), signal]),
  });
  if (!response.ok) throw new Error(`行情源 HTTP ${response.status}`);
  return parseMinutes(await response.json(), instrument, date);
}
