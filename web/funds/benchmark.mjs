import { validDate } from "../engine.mjs";

const methods = new Set(["none", "unverified", "single_index", "daily_weighted", "period_weighted"]);
const bases = new Set(["price", "total_return", "full_price", "net_price"]);
const text = (value) => typeof value === "string" && value.trim();

function orderedLevels(rows, latestDay) {
  if (!Array.isArray(rows) || rows.length > 24000) throw new Error("基准序列无效。");
  let previous = "";
  for (const row of rows) {
    const date = validDate(row?.date);
    if (date <= previous || date > latestDay || !Number.isFinite(row.value) || row.value <= 0) {
      throw new Error("基准序列日期或数值无效。");
    }
    previous = date;
  }
  return rows;
}

export function normalizeBenchmark(raw, latestDay) {
  if (raw == null) return null;
  if (raw.official !== true || !text(raw.name) || !text(raw.source)) {
    throw new Error("基准缺少正式业绩比较基准名称或出处。");
  }
  const rows = orderedLevels(raw.rows ?? [], latestDay);
  const regimes = raw.regimes ?? [];
  const series = raw.series ?? [];
  const disclosed = raw.disclosed_periods ?? [];
  if (![regimes, series, disclosed].every(Array.isArray) || (rows.length && regimes.length && raw.official_levels !== true)) {
    throw new Error("基准历史定义或官方序列声明无效。");
  }
  let prior = "";
  for (const regime of regimes) {
    const from = validDate(regime.effective_from);
    const to = regime.effective_to == null ? null : validDate(regime.effective_to);
    const components = regime.components ?? [];
    if (from <= prior || (to && to < from) || !methods.has(regime.method) || !text(regime.source)
      || !Array.isArray(components) || new Set(components.map((item) => item.id)).size !== components.length
      || (regime.method === "single_index" && components.length !== 1)
      || (["single_index", "daily_weighted", "period_weighted"].includes(regime.method)
        && (!components.length || Math.abs(components.reduce((sum, item) => sum + item.weight, 0) - 1) > 1e-8))
      || components.some((item) => !text(item.id) || !bases.has(item.basis)
        || !Number.isFinite(item.weight) || item.weight <= 0 || item.weight > 1)) {
      throw new Error("基准公式生效区间、计算口径或构成权重无效。");
    }
    prior = to ?? "9999-12-31";
  }

  const seriesById = new Map();
  for (const item of series) {
    if (!text(item.id) || !text(item.source) || !bases.has(item.basis) || seriesById.has(item.id)) {
      throw new Error("基准成分序列缺少唯一代码、收益口径或来源。");
    }
    const levels = orderedLevels(item.rows, latestDay);
    const values = new Map(levels.map(({date, value}) => [date, value]));
    const calendar = item.calendar;
    if (calendar) {
      const from = validDate(calendar.from), to = validDate(calendar.to);
      if (from > to || to > latestDay || !text(calendar.source) || !Array.isArray(calendar.sessions)
        || calendar.sessions.some((date, i, dates) => validDate(date) < from || date > to || (i && date <= dates[i - 1]))) {
        throw new Error("基准成分交易日历无效。");
      }
      const sessions = new Set(calendar.sessions);
      if (levels.some(({date}) => date >= from && date <= to && !sessions.has(date))) {
        throw new Error("基准成分点位与其交易日历冲突。");
      }
      seriesById.set(item.id, {...item, values, calendar:{...calendar, sessions}});
    } else {
      seriesById.set(item.id, {...item, values});
    }
  }

  const disclosedByWindow = new Map();
  for (const entry of disclosed) {
    const start = validDate(entry.start), end = validDate(entry.end);
    const key = start + "/" + end;
    if (start >= end || end > latestDay || !text(entry.source) || !Number.isFinite(entry.return)
      || entry.return <= -1 || disclosedByWindow.has(key)) {
      throw new Error("官方披露的区间基准收益无效。");
    }
    disclosedByWindow.set(key, entry);
  }
  return {...raw, rows, regimes, seriesById, disclosedByWindow};
}

function alignComponents(benchmark, rows) {
  const start = rows[0].date, end = rows.at(-1).date;
  const dates = new Set(rows.map(({date}) => date));
  const members = [...benchmark.seriesById].filter(([id]) => benchmark.regimes.some(({components}) =>
    components?.some((component) => component.id === id)));
  for (const [id, series] of members) {
    const windows = benchmark.regimes.filter(({components}) => components?.some((component) => component.id === id));
    const included = (date) => date >= start && date <= end && windows.some(({effective_from, effective_to}) =>
      date >= effective_from && (effective_to == null || date <= effective_to));
    for (const {date} of series.rows) if (included(date)) dates.add(date);
    for (const date of series.calendar?.sessions ?? []) if (included(date)) dates.add(date);
  }
  const timeline = [...dates].sort();
  const levels = new Map();
  for (const [id, series] of members) {
    const {calendar} = series;
    const values = new Map();
    const carry = series.rows.findLast(({date}) => date < start);
    let last = carry && calendar && carry.date >= calendar.from
      && ![...calendar.sessions].some((date) => date > carry.date && date < start) ? carry.value : undefined;
    for (const date of timeline) {
      const actual = series.values.get(date);
      if (actual !== undefined) values.set(date, actual);
      if (!calendar || date < calendar.from || date > calendar.to) continue;
      if (calendar.sessions.has(date)) last = actual;
      else if (last !== undefined) values.set(date, last);
    }
    levels.set(id, {values, basis:series.basis});
  }
  return {timeline, levels};
}

function calculateComposite(benchmark, rows) {
  const {timeline, levels} = alignComponents(benchmark, rows);
  const values = new Map([[timeline[0], 0]]);
  let priorLevel = 1, segmentBase = 1, regime, anchor;
  for (let i = 1; i < timeline.length; i++) {
    const date = timeline[i], priorDate = timeline[i - 1];
    const active = benchmark.regimes.find((item) =>
      item.effective_from <= date && (item.effective_to == null || date <= item.effective_to));
    if (!active || active.method === "none" || active.method === "unverified") {
      return {values, reason:date + " " + (active?.note ?? "缺少可核验的官方基准或计算口径。")};
    }
    if (active !== regime) {
      regime = active;
      segmentBase = priorLevel;
      anchor = priorDate;
    }
    const period = active.method === "period_weighted";
    const reference = period ? anchor : priorDate;
    let step = 0;
    for (const component of active.components) {
      const series = levels.get(component.id);
      if (series && series.basis !== component.basis) {
        return {values, reason:component.id + " 的价格、全价或全收益口径与披露定义不符。"};
      }
      const first = series?.values.get(reference), last = series?.values.get(date);
      if (first == null || last == null) {
        const missingDate = first == null ? reference : date;
        return {values, reason:(component.name ?? component.id) + " 缺少 " + missingDate + " 的可核验点位或交易日历。"};
      }
      step += component.weight * (last / first - 1);
    }
    priorLevel = (period ? segmentBase : priorLevel) * (1 + step);
    if (!Number.isFinite(priorLevel) || priorLevel <= 0) return {values, reason:"重建基准超出可计算范围。"};
    values.set(date, priorLevel - 1);
  }
  return {values};
}

export function compareBenchmark(benchmark, rows) {
  if (!benchmark) return {status:"unverified", points:[], value:null, reason:"缺少对应的官方业绩基准及可对齐历史。"};
  const start = rows[0].date, end = rows.at(-1).date;
  let values, reason;
  if (benchmark.rows.length) {
    const levels = new Map(benchmark.rows.map(({date,value}) => [date,value]));
    const base = levels.get(start);
    values = new Map();
    if (base) {
      for (const {date} of rows) {
        const defined = !benchmark.regimes.length || date === start || benchmark.regimes.some((item) =>
          item.method !== "none" && item.effective_from <= date && (item.effective_to == null || date <= item.effective_to));
        if (!defined) {
          reason = date + " 缺少适用的官方基准定义。";
          break;
        }
        if (!levels.has(date)) {
          reason = "官方基准序列缺少 " + date + "。";
          break;
        }
        values.set(date, levels.get(date) / base - 1);
      }
    } else {
      reason = "官方基准序列缺少共同起点 " + start + "。";
    }
  } else {
    ({values, reason} = calculateComposite(benchmark, rows));
  }
  const points = rows.filter(({date}) => values.has(date)).map(({date}) => ({time:date, value:values.get(date)}));
  const complete = values.has(end);
  const disclosed = benchmark.disclosedByWindow.get(start + "/" + end);
  if (complete && disclosed && Math.abs(values.get(end) - disclosed.return) > 0.0001) {
    return {status:"unverified", points:[], value:null, reason:"重建基准与同区间官方披露结果不符。"};
  }
  return {
    status:complete ? "complete" : points.length > 1 ? "partial" : disclosed ? "disclosed" : "unverified",
    points:points.length > 1 ? points : [],
    value:complete ? values.get(end) : disclosed?.return ?? null,
    disclosed,
    reason:complete ? null : reason ?? "缺少可核验的官方基准历史。",
  };
}
