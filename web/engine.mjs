// Portable daily-data/indicator engine. Formulas match stock_analysis/indicators.py.
export const FIELDS = [
  "date",
  "open",
  "close",
  "high",
  "low",
  "volume_lots",
  "turnover_cny",
];
const SH_INDICES = new Set([
  "000001",
  "000016",
  "000300",
  "000688",
  "000852",
  "000905",
  "000906",
  "000985",
]);

export function resolveSymbol(value, kind = "auto") {
  if (!["auto", "stock", "index"].includes(kind)) throw new Error("类型无效");
  const match = /^(sh|sz)?(\d{6})$/.exec(String(value).trim().toLowerCase());
  if (!match) throw new Error("请输入六位代码或 sh/sz 前缀代码");
  let [, market, code] = match;
  if (code === "000001" && !market && kind === "auto")
    throw new Error("000001 有歧义：请用 sh000001（指数）或 sz000001（股票）");
  if (kind === "auto")
    kind =
      code.startsWith("399") ||
      (market === "sh" && code.startsWith("000")) ||
      (SH_INDICES.has(code) && market !== "sz")
        ? "index"
        : "stock";
  const expected =
    kind === "index"
      ? code.startsWith("399")
        ? "sz"
        : code.startsWith("000")
          ? "sh"
          : null
      : /^(600|601|603|605|688|689)/.test(code)
        ? "sh"
        : /^(000|001|002|003|300|301)/.test(code)
          ? "sz"
          : null;
  if (!expected || (market && market !== expected))
    throw new Error("不支持的市场与代码组合");
  return { code, market: expected, kind };
}

export function validDate(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    throw new Error("日期必须为有效的 YYYY-MM-DD");
  return value;
}

export function normalizeDaily(input) {
  if (!Array.isArray(input) || !input.length)
    throw new Error("没有历史行情记录");
  const seen = new Set();
  return input
    .map((row) => {
      validDate(row.date);
      if (seen.has(row.date)) throw new Error("交易日期重复");
      seen.add(row.date);
      const day = new Date(row.date + "T00:00:00Z").getUTCDay();
      if (day === 0 || day === 6) throw new Error("返回了周末行情");
      const result = { date: row.date };
      for (const name of FIELDS.slice(1)) {
        if (
          row[name] === null ||
          row[name] === undefined ||
          String(row[name]).trim() === "" ||
          !Number.isFinite(Number(row[name]))
        )
          throw new Error(`行情字段缺失或异常：${name}`);
        result[name] = Number(row[name]);
      }
      if (
        [result.open, result.close, result.high, result.low].some(
          (v) => v <= 0,
        ) ||
        result.low > Math.min(result.open, result.close) ||
        result.high < Math.max(result.open, result.close)
      )
        throw new Error("OHLC价格范围异常");
      if (result.volume_lots < 0 || result.turnover_cny < 0)
        throw new Error("成交量或成交额为负数");
      return result;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function calculateIndicators(input) {
  const rows = normalizeDaily(input),
    close = rows.map((r) => r.close),
    length = rows.length;
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  const rolling = (values, period) =>
    values.map((_, i) =>
      i + 1 < period ? null : mean(values.slice(i + 1 - period, i + 1)),
    );
  const ema = (values, span) => {
    const alpha = 2 / (span + 1),
      out = [values[0]];
    for (let i = 1; i < length; i++)
      out.push((1 - alpha) * out[i - 1] + alpha * values[i]);
    return out;
  };
  const columns = {
    change_pct: close.map((v, i) => (i ? (v / close[i - 1] - 1) * 100 : null)),
  };
  for (const period of [5, 10, 20, 60])
    columns[`MA${period}`] = rolling(close, period);
  for (const period of [5, 10])
    columns[`VOL${period}`] = rolling(
      rows.map((r) => r.volume_lots),
      period,
    );
  columns.EMA12 = ema(close, 12);
  columns.EMA26 = ema(close, 26);
  columns.DIF = close.map((_, i) => columns.EMA12[i] - columns.EMA26[i]);
  columns.DEA = ema(columns.DIF, 9);
  columns.MACD_hist = close.map(
    (_, i) => 2 * (columns.DIF[i] - columns.DEA[i]),
  );
  const delta = close.map((v, i) => (i ? v - close[i - 1] : 0));
  for (const period of [6, 12, 14, 24]) {
    const out = Array(length).fill(null);
    if (length > period) {
      let gain = mean(delta.slice(1, period + 1).map((v) => Math.max(v, 0)));
      let loss = mean(delta.slice(1, period + 1).map((v) => Math.max(-v, 0)));
      for (let i = period; i < length; i++) {
        if (i > period) {
          gain = (gain * (period - 1) + Math.max(delta[i], 0)) / period;
          loss = (loss * (period - 1) + Math.max(-delta[i], 0)) / period;
        }
        out[i] = gain + loss === 0 ? 50 : (100 * gain) / (gain + loss);
      }
    }
    columns[`RSI${period}`] = out;
  }
  const smooth = (values) => {
    const out = Array(length).fill(null);
    if (length > 14) {
      out[14] = values.slice(1, 15).reduce((a, b) => a + b, 0);
      for (let i = 15; i < length; i++)
        out[i] = (out[i - 1] * 13) / 14 + values[i];
    }
    return out;
  };
  const plus = [],
    minus = [],
    tr = [];
  rows.forEach((r, i) => {
    const up = i ? r.high - rows[i - 1].high : 0,
      down = i ? rows[i - 1].low - r.low : 0;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
    tr.push(
      i
        ? Math.max(
            r.high - r.low,
            Math.abs(r.high - close[i - 1]),
            Math.abs(r.low - close[i - 1]),
          )
        : r.high - r.low,
    );
  });
  const range = smooth(tr),
    p = smooth(plus),
    m = smooth(minus);
  columns["+DI"] = range.map((v, i) =>
    v === null ? null : v === 0 ? 0 : (100 * p[i]) / v,
  );
  columns["-DI"] = range.map((v, i) =>
    v === null ? null : v === 0 ? 0 : (100 * m[i]) / v,
  );
  const dx = range.map((v, i) =>
    v === null
      ? null
      : columns["+DI"][i] + columns["-DI"][i] === 0
        ? 0
        : (100 * Math.abs(columns["+DI"][i] - columns["-DI"][i])) /
          (columns["+DI"][i] + columns["-DI"][i]),
  );
  columns.ADX14 = Array(length).fill(null);
  if (length >= 28) columns.ADX14[27] = mean(dx.slice(14, 28));
  for (let i = 28; i < length; i++)
    columns.ADX14[i] = (columns.ADX14[i - 1] * 13 + dx[i]) / 14;
  return rows.map((r, i) =>
    Object.assign(
      r,
      Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, v[i]])),
    ),
  );
}

export function auditCalendar(rows, instrument, start, end, calendar) {
  if (start < calendar.start || end > calendar.end)
    throw new Error(
      `日期超出已验证交易日历 ${calendar.start} — ${calendar.end}，请等待站点更新`,
    );
  const expected = new Set(
      calendar.sessions.filter((d) => d >= start && d <= end),
    ),
    actual = new Set(rows.map((r) => r.date));
  if (rows.some((r) => !expected.has(r.date)))
    throw new Error("行情包含非交易日或请求范围外日期");
  const missing = [...expected].filter((d) => !actual.has(d));
  const evidence = calendar.suspensions.filter(
    (s) =>
      s.symbol === instrument.market + instrument.code &&
      s.kind === instrument.kind &&
      s.start <= end &&
      s.end >= start,
  );
  const suspended = (day) =>
    evidence.some((s) => s.start <= day && s.end >= day);
  const interior = missing.filter(
    (d) => d >= rows[0].date && d <= rows.at(-1).date,
  );
  if (instrument.kind === "index" && interior.length)
    throw new Error("指数存在内部交易日缺口，拒绝展示不完整序列");
  return {
    calendar: calendar.calendar,
    calendar_version: calendar.version,
    expected_sessions: expected.size,
    observed_sessions: actual.size,
    missing_sessions: missing,
    interior_missing_sessions: interior,
    confirmed_suspension_sessions: missing.filter(suspended),
    unverified_missing_sessions: missing.filter((d) => !suspended(d)),
    suspension_evidence: evidence,
    suspension_data_conflicts: [...actual].filter(suspended),
    completeness_verified: instrument.kind === "index" && !missing.length,
  };
}
