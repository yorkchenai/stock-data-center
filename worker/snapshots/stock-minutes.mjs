import { resolveSymbol } from "../../web/engine.mjs";
import { hasFullMinuteSession, marketClock, minuteURL, readMinuteSeries } from "../../web/timeframes.mjs";

const reading = new Map();

async function readJSON(url) {
  const response = await fetch(url, {
    redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(4_500),
  });
  if (response.redirected || !response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", {fatal:true});
  let text = "", bytes = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65_536) throw new Error("Minute response exceeds size limit");
      text += decoder.decode(value, {stream:true});
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(text + decoder.decode());
}

function minutesFromMidnight(stamp) {
  return Number(stamp.slice(0,2))*60+Number(stamp.slice(2));
}

export function tencentMinutePayload(kline, quote, instrument, date) {
  const symbol = instrument.market + instrument.code;
  const key = date.replaceAll("-","");
  const candles = kline?.data?.[symbol];
  const ticks = quote?.data?.[symbol];
  if (candles?.qt?.[symbol]?.[2] !== instrument.code || ticks?.qt?.[symbol]?.[2] !== instrument.code ||
      ticks.data?.date !== key || !Array.isArray(ticks.data.data) || !Array.isArray(candles.m1)) {
    throw new Error("Tencent returned a different symbol or session");
  }
  const lotsDivisor = /^sh68[89]/.test(symbol) ? 100 : 1;
  let previous;
  const totals = new Map();
  for (const row of ticks.data.data) {
    const [stamp, close, volume, amount] = row.split(" ");
    if (!/^\d{4}$/.test(stamp) || !/^\d+(\.\d+)?$/.test(amount ?? "") || !/^\d+(\.\d+)?$/.test(volume ?? "")) continue;
    const slot = minutesFromMidnight(stamp), cumulative = Number(amount);
    if (!((slot >= 570 && slot <= 690) || (slot >= 780 && slot <= 900))) continue;
    if (previous && slot <= previous.slot) throw new Error("Tencent minute times are not sequential");
    // Tencent may report a 13:00 reference tick. When it is absent, the 11:30
    // cumulative total is the baseline for the first afternoon minute.
    const baseline = slot === 570 ? 0 : previous && (slot === previous.slot+1 ||
      (previous.slot === 690 && (slot === 780 || slot === 781))) ? previous.cumulative : null;
    previous = {slot, cumulative};
    if (baseline !== null && cumulative >= baseline) totals.set(stamp, {
      close: Number(close), turnover: cumulative-baseline,
      average: instrument.kind === "stock" && Number(volume) > 0 ? cumulative/(Number(volume)*100/lotsDivisor) : "",
    });
  }
  const trends = [];
  for (const [stamp, open, close, high, low, volume] of candles.m1) {
    if (!/^\d{12}$/.test(stamp) || !stamp.startsWith(key) || !/^\d+(\.\d+)?$/.test(volume ?? "")) continue;
    const label = stamp.slice(8), tick = totals.get(label);
    if (!tick || tick.close !== Number(close)) continue;
    trends.push([date+" "+label.slice(0,2)+":"+label.slice(2), open, close, high, low,
      Number(volume)/lotsDivisor, tick.turnover, tick.average].join(","));
  }
  return {provider:"tencent", data:{code:instrument.code, market:instrument.market === "sh" ? 1 : 0,
    preClose:candles.prec, trends}};
}

function checkedPayload(payload, instrument, date) {
  const series = readMinuteSeries(payload, instrument, date);
  return {payload, complete:hasFullMinuteSession(series,date), latest:series.latest, missing:series.missing};
}

async function eastmoney(instrument, date) {
  const {data} = await readJSON(minuteURL(instrument));
  return checkedPayload({data:{code:data.code, market:data.market, preClose:data.preClose,
    time:data.time, trends:data.trends}},instrument,date);
}

async function tencent(instrument, date) {
  const symbol = instrument.market + instrument.code;
  const base = "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/";
  const [kline, quote] = await Promise.all([
    readJSON(base + "kline/mkline?" + new URLSearchParams({param:symbol+",m1,,320"})),
    readJSON(base + "minute/query?" + new URLSearchParams({code:symbol})),
  ]);
  return checkedPayload(tencentMinutePayload(kline,quote,instrument,date),instrument,date);
}

async function readStockMinutes(instrument, date) {
  const primary = await eastmoney(instrument,date).catch(() => null);
  if (primary?.missing === 0) return primary;
  const [retry, backup] = await Promise.all([
    eastmoney(instrument,date).catch(() => null),
    tencent(instrument,date).catch(() => null),
  ]);
  return [retry, primary, backup].filter(Boolean)
    .sort((a,b) => Number(b.complete)-Number(a.complete) || b.latest-a.latest || a.missing-b.missing)[0];
}

export async function fetchPublicStockMinutes(request, allowedOrigin, calendar, ctx) {
  const origin = request.headers.get("Origin");
  const headers = {Vary:"Origin", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff"};
  if (!allowedOrigin || (origin !== null && origin !== allowedOrigin)) {
    return Response.json({status:"access_denied"}, {status:403, headers});
  }
  if (origin) headers["Access-Control-Allow-Origin"] = allowedOrigin;
  const send = (data, status=200) => Response.json(data, {status, headers});
  if (request.method !== "GET") return send({status:"method_not_allowed"}, 405);
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol"), date = url.searchParams.get("date");
  if (url.search.length > 52 || [...url.searchParams].length !== 2 || !/^(sh|sz)\d{6}$/.test(symbol ?? "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return send({status:"invalid_arguments"}, 400);
  let instrument;
  try { instrument = resolveSymbol(symbol); }
  catch { return send({status:"invalid_arguments"}, 400); }
  const now = Date.now();
  const clock = marketClock(calendar, now);
  if (!clock.dataDate) return send({status:"calendar_unavailable"}, 503);
  if (date !== clock.dataDate) return send({status:"session_mismatch"}, 409);

  url.search = new URLSearchParams({symbol, date});
  const key = new Request(url);
  const cache = globalThis.caches?.default;
  const hit = await cache?.match(key).catch(() => null);
  if (hit) return new Response(hit.body, {headers:{...headers, "Content-Type":"application/json"}});
  let pending = reading.get(key.url);
  if (!pending) {
    pending = readStockMinutes(instrument, date).finally(() => reading.delete(key.url));
    reading.set(key.url, pending);
  }
  const result = await pending;
  if (!result) return send({status:"upstream_unavailable"}, 502);
  if (cache && ctx?.waitUntil) {
    const expiry = result.complete && now >= result.latest + 120_000 ? 3600 : 15;
    const response = Response.json(result.payload, {headers:{"Cache-Control":`public, max-age=${expiry}`}});
    ctx.waitUntil(cache.put(key, response).catch(() => {}));
  }
  return send(result.payload);
}
