import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSymbol,
  normalizeDaily,
  auditCalendar,
} from "../web/engine.mjs";
import {
  parseEastmoney,
  parseTencent,
  fetchTencent,
  fetchHistory,
  eastmoneyURL,
} from "../web/providers.mjs";

// Artificial transport fixtures only, not market prices or backtest results.
const row = {
  date: "2025-01-06",
  open: 10,
  close: 11,
  high: 12,
  low: 9,
  volume_lots: 234,
  turnover_cny: 123456,
};
const calendar = {
  start: "2020-01-01",
  end: "2026-12-31",
  sessions: [row.date],
  suspensions: [],
};
test("market resolution agrees with backend including ambiguous 000001", () => {
  for (const [symbol, market, kind] of [
    ["000688", "sh", "index"],
    ["600519", "sh", "stock"],
    ["399006", "sz", "index"],
    ["sh000001", "sh", "index"],
    ["sz000001", "sz", "stock"],
    ["300750", "sz", "stock"],
    ["688981", "sh", "stock"],
  ]) {
    assert.deepEqual(resolveSymbol(symbol), {
      code: symbol.slice(-6),
      market,
      kind,
    });
  }
  for (const bad of ["000001", "sz600519", "510300", "sh300750", "600519/../x"])
    assert.throws(() => resolveSymbol(bad));
});
test("normalization rejects missing fields, duplicate dates and invalid OHLCV", () => {
  for (const change of [
    { volume_lots: null },
    { turnover_cny: "" },
    { low: 11 },
    { high: 9 },
    { close: Infinity },
    { volume_lots: -1 },
    { date: "2025-01-05" },
    { date: "2025-02-30" },
  ])
    assert.throws(() => normalizeDaily([{ ...row, ...change }]));
  assert.throws(() => normalizeDaily([row, row]));
  assert.equal(normalizeDaily([row])[0].volume_lots, 234);
});
test("Eastmoney returns canonical lots and CNY; identity is checked", () => {
  const instrument = resolveSymbol("000688");
  const payload = {
    data: {
      code: "000688",
      market: 1,
      klines: ["2025-01-06,10,11,12,9,234,123456"],
    },
  };
  assert.deepEqual(parseEastmoney(payload, instrument), [row]);
  assert.throws(() => parseEastmoney(payload, resolveSymbol("600519")));
  const url = new URL(eastmoneyURL(instrument, row.date, row.date));
  assert.equal(url.searchParams.get("secid"), "1.000688");
  assert.equal(url.searchParams.get("fqt"), "0");
});
test("Tencent raw unit conversion matches AkShare and is applied only at source boundary", () => {
  for (const symbol of ["000688", "600519", "399006", "sh000001", "688981"]) {
    const instrument = resolveSymbol(symbol),
      key = instrument.market + instrument.code;
    const rawVolume = symbol === "688981" ? 23400 : 234;
    const payload = {
      data: {
        [key]: {
          day: [
            [
              row.date,
              "10",
              "11",
              "12",
              "9",
              String(rawVolume),
              {},
              "0",
              "12.3456",
            ],
          ],
        },
      },
    };
    assert.equal(parseTencent(payload, instrument)[0].volume_lots, 234);
    assert.equal(
      parseTencent(payload, instrument)[0].turnover_cny,
      12.3456 * 10000,
    );
    assert.throws(() =>
      parseTencent(
        { data: { [key]: { qfqday: payload.data[key].day } } },
        instrument,
      ),
    );
  }
});
test("Tencent divides long history into bounded two-year requests", async () => {
  const requests = [];
  const rows = await fetchTencent(
    resolveSymbol("000688"),
    "2020-07-01",
    "2026-11-20",
    async (url) => {
      const parameter = new URL(url).searchParams.get("param");
      requests.push(parameter);
      const year = parameter.split(",")[2].slice(0, 4);
      return {
        data: {
          sh000688: { day: [[`${year}-07-01`, 10, 11, 12, 9, 234, {}, 0, 12]] },
        },
      };
    },
  );
  assert.equal(requests.length, 4);
  assert.equal(rows.length, 4);
  assert.match(requests[0], /2020-01-01,2021-12-31,640,$/);
  assert.match(requests.at(-1), /2026-01-01,2027-12-31,640,$/);
});
test("Tencent padded overlaps are trimmed to each requested segment, with internal duplicates rejected", async () => {
  const raw = (date) => [date, 10, 11, 12, 9, 234, {}, 0, 12];
  const instrument = resolveSymbol("000688");
  const rows = await fetchTencent(
    instrument,
    "2020-07-01",
    "2023-12-31",
    async (url) => {
      const year = new URL(url).searchParams
        .get("param")
        .split(",")[2]
        .slice(0, 4);
      return {
        data: {
          sh000688: {
            day: (year === "2020"
              ? ["2020-07-01", "2021-12-31"]
              : ["2021-12-31", "2022-01-04", "2023-12-29"]
            ).map(raw),
          },
        },
      };
    },
  );
  assert.deepEqual(
    rows.map((row) => row.date),
    ["2020-07-01", "2021-12-31", "2022-01-04", "2023-12-29"],
  );
  await assert.rejects(
    fetchTencent(instrument, "2020-07-01", "2021-12-31", async () => ({
      data: { sh000688: { day: [raw("2020-07-01"), raw("2020-07-01")] } },
    })),
    /重复/,
  );
});

test("calendar keeps confirmed suspensions separate and rejects index interior gaps", () => {
  const dates = ["2025-01-06", "2025-01-07", "2025-01-08"];
  const config = {
    ...calendar,
    sessions: dates,
    suspensions: [
      { symbol: "sh688981", kind: "stock", start: dates[1], end: dates[1] },
    ],
  };
  const rows = [row, { ...row, date: dates[2] }];
  const audit = auditCalendar(
    rows,
    resolveSymbol("688981"),
    dates[0],
    dates[2],
    config,
  );
  assert.deepEqual(audit.confirmed_suspension_sessions, [dates[1]]);
  assert.deepEqual(audit.unverified_missing_sessions, []);
  assert.equal(audit.completeness_verified, false);
  assert.throws(
    () =>
      auditCalendar(rows, resolveSymbol("000688"), dates[0], dates[2], config),
    /缺口/,
  );
  assert.throws(
    () =>
      auditCalendar(
        rows,
        resolveSymbol("688981"),
        dates[0],
        "2027-01-01",
        config,
      ),
    /日历/,
  );
});
test("Eastmoney names come from matching response metadata without extra requests", async () => {
  let calls = 0;
  const options = {
    symbol: "600519",
    kind: "auto",
    start: row.date,
    end: row.date,
  };
  const get = async (name) =>
    fetchHistory(options, calendar, async () => {
      calls++;
      return {
        data: {
          code: "600519",
          market: 1,
          name,
          klines: ["2025-01-06,10,11,12,9,234,123456"],
        },
      };
    });
  assert.equal((await get(" 贵州茅台 ")).instrument_name, "贵州茅台");
  assert.equal(calls, 1);
  for (const name of [null, {}, "  "])
    assert.equal((await get(name)).instrument_name, null);
});

test("Tencent fallback uses only name metadata for the requested instrument", async () => {
  let calls = 0;
  const options = {
    symbol: "600519",
    kind: "auto",
    start: row.date,
    end: row.date,
  };
  const get = async (quote) =>
    fetchHistory(options, calendar, async (url) => {
      calls++;
      if (url.includes("eastmoney")) throw new Error("test offline");
      return {
        data: {
          sh600519: {
            day: [[row.date, 10, 11, 12, 9, 234, {}, 0, 12]],
            qt: { sh600519: quote },
          },
        },
      };
    });
  assert.equal(
    (await get(["1", "贵州茅台", "600519"])).instrument_name,
    "贵州茅台",
  );
  assert.equal(calls, 2);
  assert.equal((await get(["1", "其他标的", "000688"])).instrument_name, null);
  assert.equal((await get(undefined)).instrument_name, null);
});

test("failed primary uses validated fallback, never an old snapshot or filled rows", async () => {
  let calls = 0;
  const result = await fetchHistory(
    { symbol: "000688", kind: "auto", start: row.date, end: row.date },
    calendar,
    async (url) => {
      calls++;
      if (url.includes("eastmoney")) throw new Error("test HTTP 503");
      return {
        data: {
          sh000688: { day: [[row.date, 10, 11, 12, 9, 234, {}, 0, 12.3456]] },
        },
      };
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.source, "tencent");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].volume_lots, 234);
  assert.equal(result.attempts[0].status, "failed");
  await assert.rejects(
    fetchHistory(
      { symbol: "000688", kind: "auto", start: row.date, end: row.date },
      calendar,
      async () => {
        throw new Error("test offline");
      },
    ),
    /未使用存档替代/,
  );
});
