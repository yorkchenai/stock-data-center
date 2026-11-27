import { COLORS, PANELS, chartTime, dateKey, formatValue, linePoints, seriesData } from "./data.mjs";
import { fetchHistory } from "./providers.mjs";
import { STOCK_ANALYSIS_START } from "./engine.mjs";
import { aggregatePeriods, fetchMinutes, marketClock, minuteFreshness, nextMinuteRefresh } from "./timeframes.mjs";
import { browserModelVersion, getPageSnapshot, snapshotNote, snapshotsEnabled } from "./snapshot-client.mjs";

const isPages = document.documentElement?.dataset?.mode === "pages";
let calendarPromise;
function loadCalendar() {
  calendarPromise ||= fetch("./calendar.json", { cache: "no-store" })
    .then((response) => {
      if (!response.ok)
        throw new Error(`无法读取交易日历（HTTP ${response.status}）`);
      return response.json();
    })
    .catch((error) => {
      calendarPromise = null;
      throw error;
    });
  return calendarPromise;
}

const LC = window.LightweightCharts;
const elements = Object.fromEntries(
  [
    "query-form",
    "symbol",
    "kind",
    "start",
    "end",
    "load",
    "demo",
    "range-form",
    "display-start",
    "display-end",
    "status",
    "instrument-name",
    "instrument-code",
    "quote-close",
    "quote-caption",
    "quote-change",
    "source-label",
    "history-label",
    "loaded-range",
    "visible-range",
    "range-controls",
    "timeframe-status",
    "minute-refresh",
    "detail-title",
    "chart",
    "chart-shell",
    "legends",
    "selected-date",
    "locate-form",
    "locate-date",
    "daily-values",
    "validation-note",
    "data-timestamp",
  ].map((id) => [id, document.getElementById(id)]),
);
const state = {
  dataset: null,
  rows: [],
  byDate: new Map(),
  busy: false,
  displayRangeDraft: false,
  period: "day",
  dailyViewport: null,
  dailyStatus: null,
  calendar: null,
  minuteData: null,
  minuteError: null,
  minuteRequest: null,
  timer: null,
  viewGeneration: 0,
};
const detailGroups = [
  [
    "价格与均线",
    [
      ["open", "开盘"],
      ["high", "最高"],
      ["low", "最低"],
      ["close", "收盘"],
      ["MA5", "MA5"],
      ["MA10", "MA10"],
      ["MA20", "MA20"],
      ["MA60", "MA60"],
      ["average", "分时均价"],
    ],
  ],
  [
    "成交量 · 手",
    [
      ["volume_lots", "成交量（手）"],
      ["turnover_cny", "成交额（元）"],
      ["VOL5", "VOL5（手）"],
      ["VOL10", "VOL10（手）"],
    ],
  ],
  [
    "MACD",
    [
      ["DIF", "DIF"],
      ["DEA", "DEA"],
      ["MACD_hist", "柱值（两倍）"],
    ],
  ],
  [
    "RSI",
    [
      ["RSI6", "RSI6"],
      ["RSI12", "RSI12"],
      ["RSI14", "RSI14"],
      ["RSI24", "RSI24"],
    ],
  ],
  [
    "ADX · 独立补充",
    [
      ["ADX14", "ADX14"],
      ["+DI", "+DI"],
      ["-DI", "−DI"],
    ],
  ],
];
let priceDetailHeading;
for (const [title, fields] of detailGroups) {
  const section = document.createElement("section");
  section.className = "detail-group";
  const heading = document.createElement("h3");
  heading.textContent = title;
  if (title === detailGroups[0][0]) priceDetailHeading = heading;
  const values = document.createElement("dl");
  for (const [field, label] of fields) {
    const term = document.createElement("dt");
    term.textContent = label;
    const value = document.createElement("dd");
    value.dataset.field = field;
    value.textContent = "—";
    if (field === "average") {
      term.className = value.className = "minute-detail";
      term.hidden = value.hidden = true;
    } else if (/^MA|^(open|high|low)$/.test(field)) {
      term.className = value.className = "historical-detail";
    }
    values.append(term, value);
  }
  section.append(heading, values);
  elements["daily-values"].append(section);
}

const minuteTimeLabel = (seconds) => new Date(seconds * 1000 + 8 * 3_600_000).toISOString().slice(11, 16);
const shanghaiTime = (ms) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
const rowLabel = (row) => row.label ?? row.date;
const periodLabels = { minute: "分钟", day: "交易日", week: "周", month: "月" };
const periodStates = {
  forming: "未完成周期", incomplete: "日线数据不完整", unverified: "完整性未核实",
};

const chart = LC.createChart(elements.chart, {
  autoSize: true,
  layout: {
    background: { type: LC.ColorType.Solid, color: "#ffffff" },
    textColor: "#7d8b9a",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    fontSize: 11,
    attributionLogo: false,
    panes: { enableResize: false, separatorColor: "#e5ebf0" },
  },
  grid: { vertLines: { color: "#f0f3f6" }, horzLines: { color: "#f0f3f6" } },
  crosshair: {
    mode: LC.CrosshairMode.Normal,
    vertLine: { color: "#74889b", labelBackgroundColor: "#344f65" },
    horzLine: { color: "#9aa9b8", labelBackgroundColor: "#344f65" },
  },
  rightPriceScale: { borderColor: "#e8edf1", minimumWidth: 76 },
  timeScale: {
    borderColor: "#e3e9ef",
    rightOffset: 2,
    timeVisible: false,
    tickMarkFormatter: (time) => typeof time === "number" ? minuteTimeLabel(time) : null,
    minBarSpacing: 0.1,
  },
  localization: {
    locale: "zh-CN", dateFormat: "yyyy-MM-dd",
    timeFormatter: (time) => typeof time === "number" ? minuteTimeLabel(time) : dateKey(time),
  },
});
const common = { priceLineVisible: false, lastValueVisible: false };
const candles = chart.addSeries(
  LC.CandlestickSeries,
  {
    ...common,
    upColor: COLORS.candleRise,
    downColor: COLORS.candleFall,
    borderVisible: true,
    borderUpColor: COLORS.rise,
    borderDownColor: COLORS.fall,
    wickUpColor: COLORS.rise,
    wickDownColor: COLORS.fall,
  },
  0,
);
const volume = chart.addSeries(
  LC.HistogramSeries,
  { ...common, priceFormat: { type: "volume" } },
  1,
);
const macd = chart.addSeries(
  LC.HistogramSeries,
  { ...common, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } },
  2,
);
const lines = new Map();
const legendElements = [];
for (const [index, panel] of PANELS.entries()) {
  const legend = document.createElement("div");
  legend.className = "pane-legend";
  legend.dataset.panel = index;
  const title = document.createElement("h3");
  title.textContent = panel.title;
  legend.append(title);
  for (const field of panel.fields) {
    const series = chart.addSeries(
      LC.LineSeries,
      {
        ...common,
        color: COLORS[field],
        lineWidth: panel.lineWidth ?? 1,
        priceFormat: {
          type: "price",
          precision: index === 1 ? 0 : 4,
          minMove: index === 1 ? 1 : 0.0001,
        },
      },
      index,
    );
    lines.set(field, series);
    const toggle = document.createElement("label");
    toggle.className = "legend-field";
    toggle.style.setProperty("--series-color", COLORS[field]);
    toggle.style.color = COLORS[field];
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.setAttribute("aria-label", `显示 ${field}`);
    checkbox.addEventListener("change", () => {
      series.applyOptions({ visible: checkbox.checked });
      toggle.classList.toggle("disabled", !checkbox.checked);
      requestAnimationFrame(positionLegends);
    });
    const name = document.createElement("span");
    name.textContent = field === "-DI" ? "−DI" : field;
    const value = document.createElement("span");
    value.className = "legend-value";
    value.dataset.field = field;
    value.textContent = "—";
    toggle.append(checkbox, name, value);
    legend.append(toggle);
  }
  elements.legends.append(legend);
  legendElements.push(legend);
}
const minutePrice = chart.addSeries(LC.LineSeries, {
  ...common, color: "#23749d", lineWidth: 1.5, visible: false,
}, 0);
const minuteAverage = chart.addSeries(LC.LineSeries, {
  ...common, color: "#976012", lineWidth: 1.5, visible: false,
}, 0);
const averageLegend = document.createElement("label");
averageLegend.className = "legend-field";
averageLegend.style.color = "#976012";
averageLegend.style.setProperty("--series-color", "#976012");
averageLegend.hidden = true;
const averageCheckbox = document.createElement("input");
averageCheckbox.type = "checkbox";
averageCheckbox.checked = true;
averageCheckbox.setAttribute("aria-label", "显示分时均价");
averageCheckbox.addEventListener("change", () => {
  minuteAverage.applyOptions({ visible: state.period === "minute" && averageCheckbox.checked });
  averageLegend.classList.toggle("disabled", !averageCheckbox.checked);
});
const averageValue = document.createElement("span");
averageValue.className = "legend-value";
averageValue.dataset.field = "average";
averageLegend.append(averageCheckbox, " 分时均价 ", averageValue);
const historicalLegend = [...legendElements[0].querySelectorAll(".legend-field")];
legendElements[0].append(averageLegend);
const periodMarkers = LC.createSeriesMarkers(candles, [], { autoScale: false });
for (const [index, pane] of chart.panes().entries()) {
  pane.setStretchFactor(PANELS[index].height);
  chart.priceScale("right", index).applyOptions({
    scaleMargins: { top: index === 0 ? 0.18 : 0.3, bottom: 0.1 },
  });
}
for (const level of [30, 50, 70]) {
  lines.get("RSI14").createPriceLine({
    price: level,
    color: "#c5d0da",
    lineWidth: 1,
    lineStyle: LC.LineStyle.Dashed,
    axisLabelVisible: false,
  });
}

const closeMarkers = ["max", "min"].map((kind) => {
  const marker = document.createElement("div");
  marker.className = "close-extreme";
  marker.dataset.extreme = kind;
  marker.setAttribute("role", "img");
  marker.hidden = true;
  const value = document.createElement("span");
  marker.append(value);
  elements.legends.append(marker);
  return { marker, value };
});
let closeExtremes = [];

function positionCloseMarkers(top, height) {
  const scale = chart.timeScale();
  const width = scale.width();
  const minTop = legendElements[0].offsetHeight + 9;
  for (const [index, { marker, value }] of closeMarkers.entries()) {
    const row = state.period === "minute" ? null : closeExtremes[index];
    const x = row ? scale.timeToCoordinate(row.date) : null;
    const y = row ? candles.priceToCoordinate(row.close) : null;
    marker.hidden = x === null || y === null || x < 0 || x > width || y < 0 || y > height;
    if (marker.hidden) continue;
    marker.style.left = `${x}px`;
    marker.style.top = `${top + y}px`;
    const left = Math.max(4, Math.min(x - value.offsetWidth / 2, width - value.offsetWidth - 4));
    const labelY = index ? y + 8 : y - value.offsetHeight - 8;
    value.style.left = `${left - x}px`;
    value.style.top = `${Math.max(minTop, Math.min(labelY, height - value.offsetHeight - 4)) - y}px`;
  }
}

function positionLegends() {
  const parent = elements["chart-shell"].getBoundingClientRect();
  chart.panes().forEach((pane, index) => {
    const node = pane.getHTMLElement();
    if (node) {
      const topOffset = node.getBoundingClientRect().top - parent.top;
      legendElements[index].style.top = `${topOffset + 5}px`;
      const scale = chart.priceScale("right", index);
      const top = Math.min(
        0.65,
        Math.max(
          index === 0 ? 0.18 : 0.3,
          (legendElements[index].offsetHeight + 14) / pane.getHeight(),
        ),
      );
      if (Math.abs(scale.options().scaleMargins.top - top) > 0.005) {
        scale.applyOptions({ scaleMargins: { top, bottom: 0.1 } });
      }
      if (index === 0) positionCloseMarkers(topOffset, pane.getHeight());
    }
  });
}
new ResizeObserver(() => requestAnimationFrame(positionLegends)).observe(
  elements.chart,
);

function setStatus(message, kind = "") {
  elements.status.textContent = message;
  elements.status.className = `status ${kind}`;
}

function showRow(row) {
  if (!row) {
    for (const id of ["selected-date", "quote-close", "quote-change"]) {
      elements[id].textContent = "—";
      elements[id].removeAttribute("title");
    }
    elements["locate-date"].value = "";
    document.querySelectorAll("[data-field]").forEach((item) => {
      item.textContent = "—";
      item.removeAttribute("title");
    });
    return;
  }
  const periodState = periodStates[row.period_state];
  elements["selected-date"].textContent = rowLabel(row) + (periodState ? ` · ${periodState}` : "");
  elements["locate-date"].value = rowLabel(row);
  elements["quote-close"].textContent = formatValue(row.close);
  elements["quote-close"].title = `原始值 ${row.close}`;
  elements["quote-change"].title = Number.isFinite(row.change_pct)
    ? `原始值 ${row.change_pct}%`
    : "该日期没有可用涨跌幅";
  elements["quote-change"].textContent = Number.isFinite(row.change_pct)
    ? `${row.change_pct > 0 ? "+" : ""}${formatValue(row.change_pct, 4)}%`
    : "—";
  elements["quote-close"].className = row.change_pct < 0 ? "fall" : "rise";
  elements["quote-change"].className = elements["quote-close"].className;
  document.querySelectorAll("[data-field]").forEach((element) => {
    const value = row[element.dataset.field];
    element.textContent = formatValue(
      value,
      element.classList.contains("legend-value") ? 4 : 8,
    );
    element.title = Number.isFinite(value)
      ? `原始值 ${value}`
      : "该指标尚无有效值";
  });
  requestAnimationFrame(positionLegends);
}

chart.subscribeCrosshairMove((parameter) => {
  const date = dateKey(parameter.time);
  if (date) showRow(state.byDate.get(date));
});
chart.subscribeClick((parameter) => {
  const date = dateKey(parameter.time);
  if (date) showRow(state.byDate.get(date));
});
function renderVisibleRange(range) {
  const from = range ? Math.max(0, Math.ceil(range.from)) : 0;
  const to = range ? Math.min(state.rows.length - 1, Math.floor(range.to)) : -1;
  const first = state.rows[from];
  const last = state.rows[to];
  let high, low;
  for (let i = from; i <= to; i++) {
    const row = state.rows[i];
    if (!Number.isFinite(row.close)) continue;
    if (!high || row.close > high.close) high = row;
    if (!low || row.close < low.close) low = row;
  }
  closeExtremes = !high ? [] : high === low ? [high] : [high, low];
  closeExtremes.forEach((row, index) => {
    const { marker, value } = closeMarkers[index];
    const kind = index ? "最低" : closeExtremes.length === 1 ? "最高及最低" : "最高";
    value.textContent = formatValue(row.close);
    marker.dataset.date = row.date;
    marker.setAttribute("aria-label", `${kind}收盘价 ${row.date} ${value.textContent}`);
  });
  requestAnimationFrame(positionLegends);
  if (first && last) {
    elements["visible-range"].textContent = `显示 ${rowLabel(first)} — ${rowLabel(last)}`;
    // A redraw/range callback can arrive while the user edits either date.
    // Keep that unsubmitted draft until Apply or an explicit chart action.
    if (state.period !== "minute" && !state.displayRangeDraft) {
      elements["display-start"].value = first.date;
      elements["display-end"].value = last.date;
    }
  }
}
chart.timeScale().subscribeVisibleLogicalRangeChange(renderVisibleRange);

function setRange(count) {
  state.displayRangeDraft = false;
  if (!state.rows.length) return;
  if (count === "all") chart.timeScale().fitContent();
  else {
    const bars = state.period === "week" ? (count === "120" ? 26 : 52)
      : state.period === "month" ? (count === "120" ? 6 : 12) : Number(count);
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, state.rows.length - bars), to: state.rows.length - 1,
    });
  }
}
for (const button of document.querySelectorAll("[data-range]"))
  button.addEventListener("click", () => setRange(button.dataset.range));

function renderRows(rows, { keepRange = false } = {}) {
  const minute = state.period === "minute";
  const range = keepRange && state.rows.length ? chart.timeScale().getVisibleLogicalRange() : null;
  const selected = keepRange ? elements["locate-date"].value : null;
  const followLatest = range && range.to >= state.rows.length - 2;
  const shift = followLatest ? Math.max(0, rows.length - state.rows.length) : 0;
  state.rows = rows;
  state.byDate = new Map(rows.map((row) => [chartTime(row), row]));
  const data = seriesData(rows);
  candles.setData(minute ? [] : data.candles);
  minutePrice.setData(minute ? linePoints(rows, "close") : []);
  minuteAverage.setData(minute ? linePoints(rows, "average") : []);
  volume.setData(data.volume);
  macd.setData(data.macd);
  for (const [field, series] of lines) series.setData(data.lines[field]);
  periodMarkers.setMarkers(rows.filter((row) => row.period_state === "forming").map((row) => ({
    time: row.date, position: "aboveBar", shape: "circle", color: "#a26827", size: 1, text: "未完成",
  })));
  if (!rows.length) {
    closeExtremes = [];
    elements["visible-range"].textContent = "—";
  }
  showRow(rows.find((row) => rowLabel(row) === selected) ?? rows.at(-1));
  if (rows.length && range) chart.timeScale().setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
  else setRange(minute ? "all" : "244");
  renderVisibleRange(chart.timeScale().getVisibleLogicalRange());
}

function displayDataset(dataset) {
  if (!dataset.rows?.length) throw new Error("所选区间没有行情记录");
  state.dataset = dataset;
  state.dailyViewport = null;
  const instrument = dataset.instrument;
  const symbol = instrument.market + instrument.code;
  const name =
    typeof dataset.instrument_name === "string" &&
    dataset.instrument_name.trim()
      ? dataset.instrument_name.trim()
      : symbol === "sh000688" && instrument.kind === "index"
        ? "科创50"
        : "名称暂不可用";
  elements["instrument-name"].textContent = name;
  elements["instrument-code"].textContent =
    `${symbol} · ${instrument.kind === "index" ? "指数" : "A股股票"}`;
  elements.symbol.value = symbol;
  elements.kind.value = instrument.kind;
  elements.start.value = dataset.requested_start;
  elements.end.value = dataset.requested_end;
  if (isPages && snapshotsEnabled && dataset.snapshot) {
    elements.start.value = STOCK_ANALYSIS_START;
    elements.end.value = new Date(Date.now()+8*3_600_000).toISOString().slice(0,10);
  }
  elements["source-label"].textContent =
    `来源 ${{ repository_csv: "仓库真实历史样本", local_csv: "已保存行情", eastmoney: "东方财富", tencent: "腾讯" }[dataset.source] || dataset.source} · 不复权`;
  elements["history-label"].textContent =
    `已载入 ${dataset.rows.length.toLocaleString()} 个交易日`;
  const firstDate = dataset.rows[0].date;
  const lastDate = dataset.rows.at(-1).date;
  elements["loaded-range"].textContent = `载入范围 ${firstDate} — ${lastDate}`;
  for (const input of [elements["display-start"], elements["display-end"]]) {
    input.min = firstDate;
    input.max = lastDate;
  }
  const canLoad = isPages || dataset.live_analysis;
  elements.symbol.readOnly = !canLoad;
  elements.kind.disabled = !canLoad;
  elements.start.disabled = !canLoad;
  elements.end.disabled = !canLoad;
  elements["data-timestamp"].textContent = dataset.snapshot
    ? `存档样本 · 构建于 ${dataset.generated_at_utc}；非最新行情`
    : [dataset.analysis_label, dataset.fetched_at_utc && `取数完成 ${dataset.fetched_at_utc}`].filter(Boolean).join(" · ");
  const check = dataset.validation;
  elements["validation-note"].textContent = check
    ? `已确认停牌 ${check.confirmed_suspension_sessions?.length || 0} 日；未核实缺口 ${check.unverified_missing_sessions?.length ?? check.missing_sessions.length} 日；停牌数据冲突 ${check.suspension_data_conflicts?.length || 0} 日。未核实缺口包括上市前或范围边界，不能直接认定为源数据缺失。股票完整性仍需核实。`
    : "演示使用仓库已保存的1551条科创50真实日线。指标由现有Python模块计算。";
  setStatus(
    dataset.analysis_label
      ? dataset.analysis_label + "。调整显示区间只改变视窗。"
      : isPages
      ? dataset.snapshot
        ? "已展示明确标注日期的存档样本。点击“加载历史行情”向公开行情源取数；调整显示区间只改变视窗。"
        : `已从公开行情源载入历史。${dataset.attempts?.some((a) => a.status === "failed") ? "东方财富请求失败，已使用腾讯备用源。" : ""}调整显示区间只改变视窗。`
      : dataset.live_analysis
        ? "已载入历史。上方可重新获取行情，下方可调整显示区间。"
        : "离线样本已载入，可在图表上方调整显示区间。获取其他行情请启动 Python 交互服务。",
  );
  state.dailyStatus = elements.status.textContent;
  state.dailySummary = Object.fromEntries(
    ["source-label", "history-label", "loaded-range", "data-timestamp", "validation-note"].map(
      (id) => [id, elements[id].textContent],
    ),
  );
  void selectTimeframe(state.period);
}

function showTimeframeStatus(message, incomplete = false) {
  const label = elements["timeframe-status"];
  label.hidden = !message;
  label.textContent = message;
  label.toggleAttribute("data-incomplete", incomplete);
}

function syncTimeframeControls() {
  const minute = state.period === "minute";
  document.querySelectorAll("[data-timeframe]").forEach((button) =>
    button.setAttribute("aria-pressed", String(button.dataset.timeframe === state.period)));
  elements["range-form"].hidden = elements["range-controls"].hidden = minute;
  elements["minute-refresh"].hidden = !minute;
  elements["minute-refresh"].disabled = Boolean(state.minuteRequest);
  elements["locate-date"].type = minute ? "time" : "date";
  elements["locate-date"].setAttribute("aria-label", minute ? "定位分钟" : "定位交易日");
  elements["detail-title"].textContent = periodLabels[state.period] + "明细";
  priceDetailHeading.textContent = minute ? "分时价格与均价" : detailGroups[0][0];
  elements["quote-caption"].textContent = minute ? "所选分钟价格"
    : state.period === "day" ? "所选交易日收盘" : "所选" + periodLabels[state.period] + "K收盘";
  elements.chart.setAttribute("aria-label", minute ? "分时价格、均价、成交量、MACD、RSI和ADX，共用时间轴"
    : "K线、成交量、MACD、RSI和ADX，共用日期轴");
  chart.timeScale().applyOptions({ timeVisible: minute });
  candles.applyOptions({ visible: !minute });
  minutePrice.applyOptions({ visible: minute });
  minuteAverage.applyOptions({ visible: minute && averageCheckbox.checked });
  averageLegend.hidden = !minute;
  legendElements[0].querySelector("h3").textContent = minute ? "分时价格" : PANELS[0].title;
  historicalLegend.forEach((node, i) => {
    node.hidden = minute;
    lines.get(PANELS[0].fields[i]).applyOptions({ visible: !minute && node.querySelector("input").checked });
  });
  document.querySelectorAll(".historical-detail").forEach((node) => { node.hidden = minute; });
  document.querySelectorAll(".minute-detail").forEach((node) => { node.hidden = !minute; });
}

async function selectTimeframe(period) {
  if (!state.dataset) return;
  const generation = ++state.viewGeneration;
  clearTimeout(state.timer);
  state.minuteRequest?.abort();
  state.minuteRequest = null;
  state.minuteData = null;
  state.minuteError = null;
  state.period = period;
  syncTimeframeControls();
  for (const [id, value] of Object.entries(state.dailySummary)) elements[id].textContent = value;
  setStatus(state.dailyStatus);
  if (period === "day") {
    showTimeframeStatus("");
    for (const input of [elements["display-start"], elements["display-end"]]) {
      input.min = state.dataset.rows[0].date;
      input.max = state.dataset.rows.at(-1).date;
    }
    renderRows(state.dataset.rows);
    if (state.dailyViewport) chart.timeScale().setVisibleLogicalRange(state.dailyViewport);
    return;
  }
  renderRows([]);
  showTimeframeStatus(period === "minute" ? "正在读取分时行情…" : "正在聚合日线…");
  if (period === "minute") {
    setStatus("当前显示分时行情。上方日期仅用于加载历史日线。");
    elements["source-label"].textContent = "分时来源 东方财富 · 不复权";
    elements["history-label"].textContent = "分时记录 —";
    elements["loaded-range"].textContent = "分时日期 —";
    elements["data-timestamp"].textContent = "";
    elements["validation-note"].textContent = "分时均价使用来源字段。MACD、RSI、ADX 按分钟计算，预热不足显示 —。";
    elements["minute-refresh"].disabled = true;
  }
  const calendar = await loadCalendar().catch(() => null);
  if (generation !== state.viewGeneration) return;
  state.calendar = calendar;
  if (period === "minute") {
    void refreshMinute();
    scheduleMinuteRefresh();
    return;
  }
  try {
    const dataset = state.dataset;
    const rows = aggregatePeriods(dataset.periodRows ?? dataset.rows, period, {
      calendar, instrument: dataset.instrument,
    }).filter((row) => row.date >= dataset.rows[0].date);
    elements["history-label"].textContent = `已载入 ${rows.length.toLocaleString()} 根${periodLabels[period]}K`;
    elements["loaded-range"].textContent = `载入范围 ${rows[0].period_start} — ${rows.at(-1).date}`;
    for (const input of [elements["display-start"], elements["display-end"]]) {
      input.min = rows[0].date;
      input.max = rows.at(-1).date;
    }
    elements["validation-note"].textContent += " 周K、月K由已载入日线聚合，指标在同周期序列重算。";
    const latest = rows.at(-1);
    const issues = rows.filter((row) => row.period_state !== "complete").length;
    const hint = [`由日线聚合 · 指标按${periodLabels[period]}K重算`];
    if (periodStates[latest.period_state]) hint.push(`最后一根：${periodStates[latest.period_state]}`);
    if (issues) hint.push(`${issues} 根未完成或完整性未核实`);
    showTimeframeStatus(hint.join(" · "), Boolean(issues));
    renderRows(rows);
  } catch (error) {
    showTimeframeStatus(error.message, true);
  }
}

function updateMinuteStatus(clock) {
  const result = state.minuteData;
  const status = [];
  if (state.minuteError) status.push(state.minuteError + (result ? "，保留上次成功的分时数据" : ""));
  if (result) {
    if (result.rows[0].date !== clock.date) status.push("最近载入交易日行情");
    status.push(`最新行情 ${shanghaiTime(result.latest).slice(0, 16)}`);
    if (result.sourceTime !== null) status.push(`源时间 ${shanghaiTime(result.sourceTime).slice(11)}`);
    status.push(`页面更新时间 ${shanghaiTime(result.received).slice(11)}（北京时间）`);
    status.push(minuteFreshness(result, clock));
    if (result.missing) status.push(`缺少 ${result.missing} 个分钟记录`);
    if (["DIF", "RSI14", "ADX14"].some((field) => !Number.isFinite(result.rows.at(-1)[field])))
      status.push("分时数据不足，部分指标不可计算");
  } else if (!state.minuteError) status.push("正在读取分时行情…");
  showTimeframeStatus(status.join(" · "), Boolean(state.minuteError || result?.missing));
}

async function refreshMinute() {
  if (state.period !== "minute" || state.minuteRequest) return;
  const generation = state.viewGeneration;
  const controller = new AbortController();
  state.minuteRequest = controller;
  elements["minute-refresh"].disabled = true;
  try {
    state.calendar ??= await loadCalendar();
    if (controller.signal.aborted || generation !== state.viewGeneration) return;
    const clock = marketClock(state.calendar);
    if (!clock.dataDate) throw new Error("缺少有效交易日历，分时刷新已暂停");
    const previous = state.minuteData;
    const result = await fetchMinutes(state.dataset.instrument, clock.dataDate, controller.signal);
    if (controller.signal.aborted || generation !== state.viewGeneration) return;
    const sameSession = previous?.rows[0].date === result.rows[0].date;
    if (sameSession && result.latest < previous.latest)
      throw new Error("来源返回的最新时间早于上次成功记录");
    state.minuteData = result;
    state.minuteError = null;
    renderRows(result.rows, { keepRange: sameSession });
    elements["history-label"].textContent = `已载入 ${result.rows.length} 条分钟记录`;
    elements["loaded-range"].textContent = `分时日期 ${clock.dataDate}`;
  } catch (error) {
    if (controller.signal.aborted || generation !== state.viewGeneration) return;
    state.minuteError = `分时更新失败：${error.name === "TimeoutError" ? "行情源超时" : error.message}`;
  } finally {
    if (state.minuteRequest === controller) {
      state.minuteRequest = null;
      elements["minute-refresh"].disabled = false;
      updateMinuteStatus(marketClock(state.calendar));
    }
  }
}

function scheduleMinuteRefresh() {
  clearTimeout(state.timer);
  if (state.period !== "minute" || document.hidden) return;
  const now = Date.now(), clock = marketClock(state.calendar, now);
  const delay = nextMinuteRefresh(clock, now);
  if (delay === null) return;
  state.timer = setTimeout(() => {
    if (state.period !== "minute" || document.hidden) return;
    const next = marketClock(state.calendar);
    if (next.phase === "trading") void refreshMinute();
    else updateMinuteStatus(next);
    scheduleMinuteRefresh();
  }, delay);
}

for (const button of document.querySelectorAll("[data-timeframe]")) {
  button.addEventListener("click", () => {
    const period = button.dataset.timeframe;
    if (period === state.period || !state.dataset) return;
    if (state.period === "day") state.dailyViewport = chart.timeScale().getVisibleLogicalRange();
    void selectTimeframe(period);
  });
}
elements["minute-refresh"].addEventListener("click", async () => {
  await refreshMinute();
  scheduleMinuteRefresh();
});
document.addEventListener("visibilitychange", () => {
  if (state.period !== "minute") return;
  if (!document.hidden && marketClock(state.calendar).phase === "trading" &&
      Date.now() - (state.minuteData?.received ?? 0) >= 30_000) void refreshMinute();
  scheduleMinuteRefresh();
});

async function loadDemo() {
  const response = await fetch("./api/demo", { cache: "no-store" });
  if (!response.ok)
    throw new Error(`无法读取演示数据（HTTP ${response.status}）`);
  return response.json();
}

function selectStockDisplay(dataset, {start,end}) {
  const rows=dataset.rows.filter((row)=>(!start||row.date>=start)&&(!end||row.date<=end));
  if (!rows.length) throw new Error("所选区间没有行情记录");
  return {...dataset,requested_start:start||dataset.requested_start,requested_end:end||dataset.requested_end,
    periodRows: dataset.rows.filter((row) => !end || row.date <= end), rows};
}

async function loadPagesAnalysis(options, snapshotId) {
  let fallback;
  if (snapshotsEnabled) {
    try {
      const snapshot=await getPageSnapshot({asset_type:"stock",...options},snapshotId);
      const seed=snapshot.data.calculation_start??snapshot.data.requested_start;
      return {...selectStockDisplay(snapshot.data,options),analysis_label:snapshotNote(snapshot)+` · 指标起算 ${seed}`};
    } catch (error) {
      if (snapshotId) throw error;
      fallback=error.name==="TimeoutError"?"共享快照加载超时":error.message;
    }
  } else if (snapshotId) {
    throw new Error("此页面未配置该共享快照服务。");
  }
  const display={...options,start:options.start||STOCK_ANALYSIS_START,
    end:options.end||new Date(Date.now()+8*3_600_000).toISOString().slice(0,10)};
  const start=snapshotsEnabled&&display.start>STOCK_ANALYSIS_START?STOCK_ANALYSIS_START:display.start;
  const result=await fetchHistory({...display,start},await loadCalendar());
  const data=selectStockDisplay(result,display);
  const label=["网页独立取数",data.source,`截至 ${data.rows.at(-1).date}`,browserModelVersion,fallback];
  if (snapshotsEnabled) label.push(`指标起算 ${start}`);
  return {...data,analysis_label:label.filter(Boolean).join(" · ")};
}

async function runLoad(action, message = "正在读取已保存样本，请稍候…") {
  if (state.busy) return;
  state.busy = true;
  elements.load.disabled = true;
  elements.demo.disabled = true;
  setStatus(message, "loading");
  try {
    await action();
  } catch (error) {
    setStatus(
      `${error.message}${state.rows.length ? "；图表保留上次成功载入的数据。" : ""}`,
      "error",
    );
  } finally {
    state.busy = false;
    elements.load.disabled = !isPages && !state.dataset?.live_analysis;
    elements.demo.disabled = false;
  }
}

function showDateInterval(start, end) {
  if (!state.rows.length) throw new Error("请先载入历史行情");
  if (start > end) throw new Error("显示开始日期不能晚于结束日期");
  if (start < state.rows[0].date || end > state.rows.at(-1).date) {
    throw new Error(
      "显示区间超出已载入历史，请用上方“加载历史行情”扩展载入范围",
    );
  }
  const rows = state.rows.filter((row) => row.date >= start && row.date <= end);
  if (!rows.length) throw new Error("所选区间没有交易记录，请调整日期");
  state.displayRangeDraft = false;
  chart
    .timeScale()
    .setVisibleRange({ from: rows[0].date, to: rows.at(-1).date });
  showRow(rows.at(-1));

  setStatus("显示区间已调整，继续使用已载入的行情和指标。");
}

for (const name of ["display-start", "display-end"]) {
  elements[name].addEventListener("input", () => {
    state.displayRangeDraft = true;
  });
}
for (const event of ["pointerdown", "wheel"]) {
  elements.chart.addEventListener(event, () => {
    state.displayRangeDraft = false;
  });
}
elements["range-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    showDateInterval(
      elements["display-start"].value,
      elements["display-end"].value,
    );
  } catch (error) {
    setStatus(error.message, "error");
  }
});

elements["query-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  runLoad(async () => {
    const options = {
      symbol: elements.symbol.value.trim(),
      kind: elements.kind.value,
      start: elements.start.value,
      end: elements.end.value,
    };
    if (options.start > options.end)
      throw new Error("开始日期不能晚于结束日期");
    if (isPages) {
      const result = await loadPagesAnalysis(options);
      displayDataset(result);
      return;
    }
    if (!state.dataset?.live_analysis)
      throw new Error("离线样本仅支持已载入历史，请启动Python服务获取其他区间");
    const response = await fetch("./api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`行情加载失败：${result.error}`);
    displayDataset(result);
  }, "正在从行情源加载历史并读取指标结果，请稍候…");
});
elements.demo.addEventListener("click", () =>
  runLoad(async () => displayDataset(await loadDemo())),
);
elements["locate-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  const value = elements["locate-date"].value;
  const row = state.period === "minute" ? state.rows.find((row) => row.label === value)
    : state.byDate.get(value) ?? (state.period === "day" ? undefined
      : state.rows.find((row) => value && value >= row.period_start && value <= row.period_end));
  if (!row) {
    setStatus(
      "该日期没有载入的交易记录，可能为休市、停牌或超出载入范围。",
      "error",
    );
    return;
  }
  const index = state.rows.indexOf(row);
  const current = chart.timeScale().getVisibleLogicalRange();
  const width = Math.max(20, current ? current.to - current.from : 120);
  state.displayRangeDraft = false;
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, index - width / 2),
    to: Math.min(state.rows.length - 1, index + width / 2),
  });
  requestAnimationFrame(() =>
    chart.setCrosshairPosition(row.close, chartTime(row), state.period === "minute" ? minutePrice : candles),
  );
  showRow(row);
  setStatus(state.period === "day" ? `已定位 ${row.date}，右侧显示该交易日原始指标数值。`
    : `已定位 ${rowLabel(row)}，查看对应周期指标。`);
});
if (isPages) elements.demo.textContent = "查看存档样本";
const requestedPage=isPages?new URLSearchParams(location.search):null;
const privateSymbol=Boolean(document.documentElement?.dataset?.analysisPath && requestedPage?.has("symbol"));
if (requestedPage?.has("snapshot_id") || privateSymbol) {
  runLoad(async()=>displayDataset(await loadPagesAnalysis({
    symbol:requestedPage.get("symbol"),kind:requestedPage.get("kind")??"auto",
    start:requestedPage.get("start")??undefined,end:requestedPage.get("end")??undefined,
  },requestedPage.get("snapshot_id"))),"正在读取共享行情快照…");
} else runLoad(async () => displayDataset(await loadDemo()));
