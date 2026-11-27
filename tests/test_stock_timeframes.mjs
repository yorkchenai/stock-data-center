import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  aggregatePeriods, fetchMinutes, hasFullMinuteSession, marketClock, minuteFreshness, minuteURL, nextMinuteRefresh, parseMinutes,
} from "../web/timeframes.mjs";
import { calculateIndicators } from "../web/engine.mjs";
import { mountSnapshotSite } from "../worker/snapshots/site-gateway.mjs";
import { tencentMinutePayload } from "../worker/snapshots/stock-minutes.mjs";

const instrument = { code: "000688", market: "sh", kind: "index" };
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const date = "2026-11-27";
const indicatorFields = ["MA5", "MA20", "VOL5", "DIF", "DEA", "MACD_hist", "RSI14", "ADX14", "+DI", "-DI"];

test("aggregates real index history by trading week or month then recalculates every indicator", async () => {
  const csv = await readFile(new URL("../results/000688_daily.csv", import.meta.url), "utf8");
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const fields = header.split(",");
  const rows = lines.map((line) => Object.fromEntries(line.split(",").map((value, i) =>
    [fields[i], fields[i] === "date" ? value : Number(value)])));
  for (const period of ["week", "month"]) {
    const expected = [];
    for (const row of rows) {
      const date = new Date(row.date + "T00:00:00Z");
      const group = period === "month" ? row.date.slice(0, 7)
        : Math.floor((date.getTime() - Date.UTC(1970, 0, 5)) / 604_800_000);
      const last = expected.at(-1);
      if (!last || last.group !== group) {
        expected.push({ ...row, group });
      } else {
        last.date = row.date;
        last.close = row.close;
        last.high = Math.max(last.high, row.high);
        last.low = Math.min(last.low, row.low);
        last.volume_lots += row.volume_lots;
        last.turnover_cny += row.turnover_cny;
      }
    }
    const aggregated = aggregatePeriods(rows, period);
    assert.deepEqual(aggregated.map(({ period_start, period_end, period_state, ...row }) => row),
      calculateIndicators(expected));
    assert.ok(indicatorFields.every((field) => Number.isFinite(aggregated.at(-1)[field])));
    assert.notEqual(aggregated.at(-1).MACD_hist, calculateIndicators(rows).at(-1).MACD_hist);
  }
});

test("calendar marks active bars and detects a clipped historical bucket", () => {
  const monday = "2026-11-23";
  const calendar = {
    start: "2026-11-01", end: "2026-12-06",
    sessions: ["2026-11-02", monday, "2026-11-24", "2026-11-25", "2026-11-26", date, "2026-11-30"],
  };
  const row = (date) => ({ date, open: 2, high: 3, low: 1, close: 2, volume_lots: 15, turnover_cny: 100 });
  const rows = calendar.sessions.slice(1, -1).map(row);
  assert.equal(aggregatePeriods(rows, "week", { calendar, now: at(date, "15:34") })[0].period_state, "forming");
  assert.equal(aggregatePeriods(rows, "week", { calendar, now: at(date, "15:35") })[0].period_state, "complete");
  assert.equal(aggregatePeriods(rows, "month", { calendar, now: at(date, "15:35") })[0].period_state, "forming");
  assert.equal(aggregatePeriods(rows, "month", { calendar, now: at("2026-12-01", "09:00") })[0].period_state, "incomplete");
  assert.equal(aggregatePeriods(rows.slice(1), "week", { calendar, now: at(date, "16:00") })[0].period_state, "incomplete");
});

test("market clock stops at Shanghai session boundaries and holidays", () => {
  const calendar = { start: "2026-11-20", end: "2026-11-30", sessions: ["2026-11-26", date, "2026-11-30"] };
  const cases = [
    ["09:29", "preopen", 60_000], ["09:30", "trading", 30_000], ["11:29", "trading", 30_000],
    ["11:30", "break", 5_400_000], ["13:00", "trading", 30_000], ["15:00", "closed", 86_400_000],
  ];
  for (const [time, phase, delay] of cases) {
    const now = at(date, time);
    const clock = marketClock(calendar, now);
    assert.equal(clock.phase, phase);
    assert.equal(nextMinuteRefresh(clock, now), delay);
  }
  const end = at(date, "11:30");
  assert.equal(nextMinuteRefresh(marketClock(calendar, end - 5000), end - 5000), 5000);
  assert.equal(marketClock(calendar, at("2026-11-28", "10:30")).dataDate, date);
  const unknown = marketClock(calendar, at("2026-12-01", "10:30"));
  assert.equal(unknown.phase, "unknown");
  assert.equal(nextMinuteRefresh(unknown, at("2026-12-01", "10:30")), null);
});

test("minutes require actual data and warmup, preserve average and reject stale or malformed provider payload", () => {
  const now = at(date, "10:10");
  const trends = Array.from({ length: 38 }, (_, index) => {
    const time = new Date(at(date, "09:30") + index * 60_000 + 8 * 3_600_000).toISOString().slice(11, 16);
    const price = 1100 + index % 4;
    return `${date} ${time},${price},${price + 1},${price + 2},${price - 1},10,200000,1100.1`;
  });
  const payload = { data: { code: "000688", market: 1, preClose: 1000, time: (now - 1000) / 1000, trends } };
  const result = parseMinutes(payload, instrument, date, now);
  assert.equal(new URL(minuteURL(instrument)).searchParams.get("secid"), "1.000688");
  assert.equal(result.rows[0].time, at(date, "09:30") / 1000);
  assert.equal(result.rows[0].average, 1100.1);
  assert.equal(result.rows[0].DIF, null);
  assert.equal(result.rows[13].RSI14, null);
  assert.equal(result.rows[26].ADX14, null);
  assert.equal(result.rows[32].DEA, null);
  assert.ok(indicatorFields.filter((field) => field !== "MA60").every((field) =>
    Number.isFinite(result.rows.at(-1)[field])));
  assert.equal(minuteFreshness(result, { phase: "trading", date }, now), "行情有延迟（至少约 180 秒）");
  assert.match(minuteFreshness(result, { phase: "break", date }, now), /暂停/);
  assert.throws(() => parseMinutes(payload, instrument, "2026-11-26", now), /来源尚未返回/);
  assert.throws(() => parseMinutes({ data: { ...payload.data, trends: [trends[2], trends[2]] } }, instrument, date, now), /重复/);
  const gap = parseMinutes({ data: { ...payload.data, trends: trends.filter((_, i) => i !== 32) } }, instrument, date, now);
  assert.equal(gap.rows.length, 37);
  assert.equal(gap.missing, 4);
  assert.equal(gap.rows.at(-1).ADX14, null);
  assert.equal(gap.rows.at(-1).DIF, null);
});

const closedDate = "2026-11-26";
const closingTrends = [[570, 690], [781, 900]].flatMap(([first, last]) =>
  Array.from({ length: last - first + 1 }, (_, i) => {
    const slot = first + i;
    const label = `${String(Math.floor(slot / 60)).padStart(2, "0")}:${String(slot % 60).padStart(2, "0")}`;
    return `${closedDate} ${label},1100,1101,1102,1099,10,200000,1100.1`;
  }));
const minuteResponse = (trends) => Response.json({ data: { code: instrument.code, market: 1, trends } });

test("a failed first load retries with its own deadline and can render a full closed session", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: at(closedDate, "15:40") });
  for (const fail of [() => new Response(null, { status: 503 }), () => { throw new DOMException("Fetch is aborted", "AbortError"); }]) {
    const caller = new AbortController();
    const signals = [];
    const fetch = t.mock.method(globalThis, "fetch", async (_, options) => {
      signals.push(options.signal);
      return signals.length === 1 ? fail() : minuteResponse(closingTrends);
    });
    try {
      const result = await fetchMinutes(instrument, closedDate, caller.signal, { completeSession: true });
      assert.equal(signals.length, 2);
      assert.notEqual(signals[0], signals[1]);
      assert.equal(hasFullMinuteSession(result, closedDate), true);
      assert.equal(result.rows.length, 241);
    } finally {
      fetch.mock.restore();
    }
  }
});

test("after close a missing final minute is retried without discarding valid partial data", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: at(closedDate, "15:40") });
  const partial = closingTrends.slice(0, -1);
  const caller = new AbortController();
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    fetch.mock.callCount() === 0 ? minuteResponse(partial) : new Response(null, { status: 503 }));
  const result = await fetchMinutes(instrument, closedDate, caller.signal, { completeSession: true });
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(hasFullMinuteSession(result, closedDate), false);
  assert.equal(result.rows.at(-1).label, "14:59");
  assert.equal(result.missing, 1);
});

test("switching charts cancels the minute retry", async (t) => {
  const caller = new AbortController();
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    caller.abort();
    throw caller.signal.reason;
  });
  await assert.rejects(fetchMinutes(instrument, closedDate, caller.signal), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 1);
});

test("stock minute relay validates the session, retries a 503 and rejects an unrelated origin", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: at(closedDate, "16:00") });
  const calendar = { start: "2026-11-25", end: "2026-11-28", sessions: ["2026-11-25", closedDate, date] };
  const origin = "https://example.github.io";
  const env = { SNAPSHOT_PUBLIC_ENABLED: "1", SNAPSHOT_MCP_OWNER_EMAIL: "owner@example.test", SNAPSHOT_PUBLIC_ORIGIN: origin };
  const gateway = mountSnapshotSite({ calendar });
  const url = `https://test.example/api/stock-minutes?symbol=sh000688&date=${closedDate}`;
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async (upstream) => {
    if (upstream !== minuteURL(instrument)) return new Response(null, {status:503});
    return ++attempts === 1 ? new Response(null, { status: 503 }) : minuteResponse(closingTrends);
  });
  assert.equal((await gateway.fetch(new Request(url, { headers: { Origin: "https://other.example" } }), env)).status, 403);
  assert.equal((await gateway.fetch(new Request(url.replace(closedDate,date)), env)).status, 409);
  assert.equal((await gateway.fetch(new Request(url + "&url=https://other.example"), env)).status, 400);
  assert.equal((await gateway.fetch(new Request(url), {...env, SNAPSHOT_PUBLIC_ENABLED: "0"})).status, 404);
  assert.equal(attempts, 0);
  const response = await gateway.fetch(new Request(url, { headers: { Origin: origin } }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.deepEqual((await response.json()).data.trends, closingTrends);
  assert.equal(attempts, 2);
  assert.equal((await gateway.fetch(new Request("https://test.example/mcp", { method: "POST" }), env)).status, 403);
});

test("Tencent sessions use matching source minutes and preserve STAR stock volume units", () => {
  const symbol = "sh688981", stock = {code:"688981", market:"sh", kind:"stock"};
  const stem = closedDate.replaceAll("-", "");
  const make = (object) => ({data:{[symbol]:{qt:{[symbol]:[null,null,stock.code]},...object}}});
  const prices = make({prec:"100",m1:[
    [stem+"0930","101","101","101","101","1100"],
    [stem+"0931","101","102","102","101","100"],
    [stem+"0932","102","103","103","102","200"],
  ]});
  const quotes = make({data:{date:stem,data:["0930 101 1100 111100", "0931 102 1200 121300", "0932 104 1400 142100"]}});
  const payload = tencentMinutePayload(prices,quotes,stock,closedDate);
  const data = parseMinutes(payload,stock,closedDate,at(closedDate,"10:00"));
  assert.equal(data.provider,"tencent");
  assert.deepEqual(data.rows.map((row) => [row.label,row.volume_lots,row.turnover_cny]),
    [["09:30",11,111100],["09:31",1,10200]]);
  assert.equal(data.rows[0].average,101);
  assert.throws(() => tencentMinutePayload(prices,quotes,stock,date), /different symbol or session/);
});

test("the browser reads the minute relay before trying a direct connection", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: at(closedDate, "16:00") });
  const fetch = t.mock.method(globalThis, "fetch", async () => minuteResponse(closingTrends));
  const result = await fetchMinutes(instrument, closedDate, new AbortController().signal, {
    relayOrigin: "https://test.example", completeSession: true,
  });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fetch.mock.calls[0].arguments[0], `https://test.example/api/stock-minutes?symbol=sh000688&date=${closedDate}`);
  assert.equal(hasFullMinuteSession(result, closedDate), true);
});
