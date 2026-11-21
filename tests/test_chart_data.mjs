import test from "node:test";
import assert from "node:assert/strict";
import {
  COLORS,
  PANELS,
  dateKey,
  formatValue,
  linePoints,
  seriesData,
} from "../web/data.mjs";

// Artificial sentinel values test the presentation adapter, not market calculations.
const sample = {
  date: "2025-01-06",
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume_lots: 123456.78,
  VOL5: 120000.25,
  VOL10: 130000.5,
  MA5: 10.12345,
  MA10: null,
  MA20: null,
  MA60: null,
  DIF: 1.123456789,
  DEA: 2.987654321,
  MACD_hist: -7.654321,
  RSI6: 12.25,
  RSI12: 23.5,
  RSI14: 34.75,
  RSI24: 45.125,
  ADX14: 56.25,
  "+DI": 67.5,
  "-DI": 78.75,
};

test("volume bars and VOL lines retain first-stage lot values exactly", () => {
  const result = seriesData([sample]);
  assert.equal(result.volume[0].value, sample.volume_lots);
  assert.equal(result.lines.VOL5[0].value, sample.VOL5);
  assert.equal(result.lines.VOL10[0].value, sample.VOL10);
  assert.match(PANELS[1].title, /手/);
});

test("MACD, RSI, ADX and moving averages are read without formulas", () => {
  const result = seriesData([sample]);
  assert.equal(result.macd[0].value, sample.MACD_hist);
  for (const panel of PANELS) {
    for (const field of panel.fields) {
      if (sample[field] !== null)
        assert.equal(result.lines[field][0].value, sample[field]);
    }
  }
  assert.equal(result.macd[0].color, COLORS.fall);
});

test("warmup nulls are whitespace at their real dates, with zero preserved", () => {
  assert.deepEqual(
    linePoints(
      [
        { date: "2025-01-06", RSI12: null },
        { date: "2025-01-07", RSI12: 0 },
      ],
      "RSI12",
    ),
    [{ time: "2025-01-06" }, { time: "2025-01-07", value: 0 }],
  );
  assert.equal(formatValue(null), "—");
  assert.equal(formatValue(0), "0");
});

test("all historical rows and their dates are retained beyond 120 days", () => {
  const rows = Array.from({ length: 1600 }, (_, index) => ({
    ...sample,
    date: `fixture-${index}`,
  }));
  const result = seriesData(rows);
  assert.equal(result.candles.length, 1600);
  assert.equal(result.volume.length, 1600);
  assert.equal(result.lines.RSI14.length, 1600);
  assert.equal(result.candles[0].time, "fixture-0");
  assert.equal(result.candles.at(-1).time, "fixture-1599");
});

test("crosshair dates normalize to a single shared daily key", () => {
  assert.equal(dateKey("2025-01-06"), "2025-01-06");
  assert.equal(dateKey({ year: 2025, month: 1, day: 6 }), "2025-01-06");
  assert.equal(dateKey(undefined), null);
});
