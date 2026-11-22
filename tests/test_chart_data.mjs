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

test("history loading and local display adjustments use separate actions", async () => {
  const created = [];
  class Element {
    constructor() {
      this.dataset = {};
      this.children = [];
      this.listeners = {};
      this.style = { setProperty() {} };
      this.classList = {
        toggle() {},
        contains: (name) => (this.className || "").split(" ").includes(name),
      };
      this.offsetHeight = 25;
      created.push(this);
    }
    append(...children) {
      this.children.push(...children);
    }
    setAttribute() {}
    addEventListener(type, callback) {
      this.listeners[type] = callback;
    }
    getBoundingClientRect() {
      return { top: 0 };
    }
    submit() {
      this.listeners.submit({ preventDefault() {} });
    }
  }
  const ids = new Map();
  const element = (id) => {
    if (!ids.has(id)) ids.set(id, new Element());
    return ids.get(id);
  };
  const presets = ["120", "244", "all"].map((range) => {
    const button = new Element();
    button.dataset.range = range;
    return button;
  });
  const rows = ["2025-01-06", "2025-01-07", "2025-01-08"].map((date) => ({
    ...sample,
    date,
  }));
  const payload = {
    instrument: { code: "000688", market: "sh", kind: "index" },
    source: "repository_csv",
    requested_start: rows[0].date,
    requested_end: rows.at(-1).date,
    rows,
    live_analysis: true,
  };
  const series = [];
  const scales = Array.from({ length: 5 }, () => ({
    margins: { top: 0.3, bottom: 0.1 },
    options() {
      return { scaleMargins: this.margins };
    },
    applyOptions(options) {
      this.margins = options.scaleMargins;
    },
  }));
  let displayedRange;
  const timeScale = {
    subscribeVisibleLogicalRangeChange(callback) {
      this.onRangeChange = callback;
    },
    fitContent() {},
    setVisibleLogicalRange() {},
    setVisibleRange(range) {
      displayedRange = range;
    },
  };
  const chart = {
    addSeries() {
      const item = {
        setData(values) {
          this.values = values;
        },
        applyOptions() {},
        createPriceLine() {},
      };
      series.push(item);
      return item;
    },
    panes: () =>
      Array.from({ length: 5 }, () => ({
        setStretchFactor() {},
        getHTMLElement: () => ({ getBoundingClientRect: () => ({ top: 0 }) }),
        getHeight: () => 180,
      })),
    priceScale: (_, index) => scales[index],
    timeScale: () => timeScale,
    subscribeCrosshairMove() {},
    subscribeClick() {},
  };
  const requests = [];
  const names = [
    "window",
    "document",
    "ResizeObserver",
    "requestAnimationFrame",
    "fetch",
  ];
  const saved = names.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  Object.assign(globalThis, {
    window: {
      LightweightCharts: {
        createChart: () => chart,
        ColorType: {},
        CrosshairMode: {},
        LineStyle: {},
      },
    },
    document: {
      getElementById: element,
      createElement: () => new Element(),
      querySelectorAll: (selector) =>
        selector === "[data-range]"
          ? presets
          : created.filter((node) => node.dataset.field),
    },
    ResizeObserver: class {
      observe() {}
    },
    requestAnimationFrame: (callback) => callback(),
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options });
      return { ok: true, json: async () => payload };
    },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await import("../web/app.mjs");
    await flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "./api/demo");
    assert.match(element("status").textContent, /已载入历史/);
    const legend = element("legends").children[0];
    legend.offsetHeight = 70; // Simulate a wrapped legend after a resize.
    element("display-start").value = rows[1].date;
    element("display-start").listeners.input();
    element("display-end").value = rows[2].date;
    element("display-end").listeners.input();
    timeScale.onRangeChange({ from: 0, to: 2 });
    assert.equal(
      element("display-start").value,
      rows[1].date,
      "redraw must preserve edited start",
    );
    assert.equal(
      element("display-end").value,
      rows[2].date,
      "redraw must preserve edited end",
    );
    element("range-form").submit();
    await flush();
    assert.ok(scales[0].margins.top >= 84 / 180);
    assert.match(element("status").textContent, /显示区间已调整/);
    assert.deepEqual(displayedRange, { from: rows[1].date, to: rows[2].date });
    timeScale.onRangeChange({ from: 0, to: 2 });
    assert.equal(
      element("display-start").value,
      rows[0].date,
      "submitted draft resumes viewport sync",
    );
    assert.equal(requests.length, 1, "display adjustment must not fetch");
    assert.equal(
      series[0].values.length,
      rows.length,
      "all loaded candles must remain available",
    );
    assert.equal(series[1].values[0].value, sample.volume_lots);
    element("display-start").value = "2020-01-01";
    element("range-form").submit();
    assert.match(element("status").textContent, /超出已载入历史/);
    assert.equal(
      requests.length,
      1,
      "out-of-range display must not trigger an implicit fetch",
    );
    element("query-form").submit();
    await flush();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].method, "POST");
    assert.equal(requests[1].url, "./api/analyze");
    assert.equal(JSON.parse(requests[1].body).symbol, "sh000688");
  } finally {
    names.forEach((name, index) => {
      if (saved[index]) Object.defineProperty(globalThis, name, saved[index]);
      else delete globalThis[name];
    });
  }
});
