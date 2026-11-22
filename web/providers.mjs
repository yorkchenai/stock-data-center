// HTTPS CORS only. No public proxy, JSONP execution, credentials or persistent cache.
import {
  FIELDS,
  resolveSymbol,
  validDate,
  normalizeDaily,
  calculateIndicators,
  auditCalendar,
} from "./engine.mjs";

export async function requestJSON(url) {
  const response = await fetch(url, {
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function eastmoneyURL(instrument, start, end) {
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  url.search = new URLSearchParams({
    secid: (instrument.market === "sh" ? "1." : "0.") + instrument.code,
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    klt: "101",
    fqt: "0",
    beg: start.replaceAll("-", ""),
    end: end.replaceAll("-", ""),
  });
  return url.href;
}

export function parseEastmoney(payload, instrument) {
  const data = payload?.data;
  if (
    data?.code !== instrument.code ||
    data.market !== (instrument.market === "sh" ? 1 : 0)
  )
    throw new Error("东方财富返回的市场/代码不匹配或标的不存在");
  return normalizeDaily(
    (data.klines || []).map((line) => {
      const values = line.split(",");
      if (values.length < 7) throw new Error("东方财富日线字段不足");
      return Object.fromEntries(FIELDS.map((name, i) => [name, values[i]]));
    }),
  );
}

export function parseTencent(payload, instrument) {
  const data = payload?.data?.[instrument.market + instrument.code];
  // Require day (unadjusted); never accept qfqday/hfqday as a substitute.
  if (!Array.isArray(data?.day))
    throw new Error("腾讯没有返回指定标的不复权日线");
  return normalizeDaily(
    data.day.map((values) => {
      if (values.length < 9) throw new Error("腾讯日线缺少成交额");
      const row = Object.fromEntries(
        FIELDS.map((name, i) => [name, values[[0, 1, 2, 3, 4, 5, 8][i]]]),
      );
      // Raw Tencent STAR stocks are shares; other supported stocks/indices are lots.
      // Mirrors AkShare 1.20.65's _tx_volume_multiplier followed by backend /100.
      if (row.volume_lots !== null && String(row.volume_lots).trim() !== "") {
        row.volume_lots =
          Number(row.volume_lots) /
          (/^sh68[89]/.test(instrument.market + instrument.code) ? 100 : 1);
      }
      if (row.turnover_cny !== null && String(row.turnover_cny).trim() !== "")
        row.turnover_cny = Number(row.turnover_cny) * 10000;
      return row;
    }),
  );
}

export async function fetchTencent(
  instrument,
  start,
  end,
  getJSON = requestJSON,
) {
  const all = [];
  // Two calendar years fit below Tencent's 640-record cap; never request one
  // giant range and silently truncate older history.
  for (
    let year = Number(start.slice(0, 4));
    year <= Number(end.slice(0, 4));
    year += 2
  ) {
    const url = new URL(
      "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get",
    );
    url.searchParams.set(
      "param",
      `${instrument.market}${instrument.code},day,${year}-01-01,${year + 1}-12-31,640,`,
    );
    const payload = await getJSON(url.href);
    if (payload?.data?.[instrument.market + instrument.code]?.day?.length === 0)
      continue; // Before listing remains a calendar gap.
    // Tencent may pad a two-year query backwards to 640 rows. Retain only
    // this segment's requested calendar years before joining; never choose
    // between conflicting records or synthesize missing days.
    all.push(
      ...parseTencent(payload, instrument).filter(
        (row) => row.date >= `${year}-01-01` && row.date <= `${year + 1}-12-31`,
      ),
    );
  }
  return normalizeDaily(all.filter((r) => r.date >= start && r.date <= end));
}

export async function fetchHistory(options, calendar, getJSON = requestJSON) {
  const instrument = resolveSymbol(options.symbol, options.kind);
  const start = validDate(options.start),
    end = validDate(options.end);
  if (start > end) throw new Error("行情开始日期不能晚于结束日期");
  if (start < calendar.start || end > calendar.end)
    throw new Error(
      `请求日期超出已验证日历 ${calendar.start} — ${calendar.end}`,
    );
  const attempts = [];
  for (const source of ["eastmoney", "tencent"]) {
    try {
      let instrumentName = null;
      const read = async (url) => {
        const payload = await getJSON(url);
        const key = instrument.market + instrument.code;
        const data = payload?.data;
        const quote = data?.[key]?.qt?.[key];
        const name =
          source === "eastmoney"
            ? data?.code === instrument.code &&
              data.market === (instrument.market === "sh" ? 1 : 0)
              ? data.name
              : null
            : Array.isArray(quote) && quote[2] === instrument.code
              ? quote[1]
              : null;
        if (typeof name === "string" && name.trim())
          instrumentName = name.trim();
        return payload;
      };
      const rows =
        source === "eastmoney"
          ? parseEastmoney(
              await read(eastmoneyURL(instrument, start, end)),
              instrument,
            ).filter((r) => r.date >= start && r.date <= end)
          : await fetchTencent(instrument, start, end, read);
      if (!rows.length) throw new Error("请求区间内无行情");
      const validation = auditCalendar(rows, instrument, start, end, calendar);
      attempts.push({ source, status: "success", rows: rows.length });
      return {
        schema_version: 1,
        instrument,
        instrument_name: instrumentName,
        source,
        requested_start: start,
        requested_end: end,
        fetched_at_utc: new Date().toISOString(),
        transport: "browser-cors",
        attempts,
        validation,
        live_analysis: true,
        units: {
          volume_lots: "手",
          VOL5: "手",
          VOL10: "手",
          turnover_cny: "元",
        },
        rows: calculateIndicators(rows),
      };
    } catch (error) {
      attempts.push({ source, status: "failed", error: error.message });
    }
  }
  throw new Error(
    `行情加载失败，未使用存档替代：${attempts.map((a) => `${a.source}: ${a.error}`).join("；")}`,
  );
}
