import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  aggregatePeriods, marketClock, minuteFreshness, minuteURL, nextMinuteRefresh, parseMinutes,
} from "../web/timeframes.mjs";
import { calculateIndicators } from "../web/engine.mjs";

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
