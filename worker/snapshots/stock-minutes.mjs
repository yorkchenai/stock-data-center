import { resolveSymbol } from "../../web/engine.mjs";
import { hasFullMinuteSession, marketClock, minuteURL, readMinuteSeries } from "../../web/timeframes.mjs";

const reading = new Map();

async function readStockMinutes(instrument, date) {
  let best;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(minuteURL(instrument), {
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5_500),
      });
      if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => {});
        if (response.status < 500 && response.status !== 408) break;
        continue;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", {fatal: true});
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
      const {data} = JSON.parse(text + decoder.decode());
      const now = Date.now();
      const series = readMinuteSeries({data}, instrument, date, now);
      const payload = {data: {code:data.code, market:data.market, preClose:data.preClose,
        time:data.time, trends:data.trends}};
      const complete = hasFullMinuteSession(series, date);
      if (complete || series.missing === 0) return {payload, complete, latest:series.latest};
      if (!best || series.latest > best.latest ||
          (series.latest === best.latest && series.missing < best.missing)) {
        best = {payload, complete, latest:series.latest, missing:series.missing};
      }
    } catch {
      // Retry transport errors and incomplete responses once without caching failures.
    }
  }
  return best;
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
