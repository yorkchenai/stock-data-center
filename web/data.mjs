// Presentation adapters only. Consume canonical values from either engine.
const rise = "#cb4551";
const fall = "#168575";
export const COLORS = {
  rise,
  fall,
  candleRise: rise + "99",
  candleFall: fall + "99",
  histogramRise: "#d46673",
  histogramFall: "#3e9e90",
  MA5: "#854000",
  MA10: "#194587",
  MA20: "#622b83",
  MA60: "#044b46",
  VOL5: "#632b00",
  VOL10: "#15356b",
  DIF: "#632b00",
  DEA: "#15356b",
  RSI6: "#bd7d10",
  RSI12: "#4273bc",
  RSI14: "#9a5fbc",
  RSI24: "#168575",
  ADX14: "#344765",
  "+DI": "#cb4551",
  "-DI": "#168575",
};
export const PANELS = [
  { title: "价格与均线", fields: ["MA5", "MA10", "MA20", "MA60"], height: 340, lineWidth: 1.5 },
  { title: "成交量 · 手", fields: ["VOL5", "VOL10"], height: 225, lineWidth: 1.5 },
  { title: "MACD · 两倍柱值", fields: ["DIF", "DEA"], height: 225, lineWidth: 1.5 },
  {
    title: "RSI · 相对强弱",
    fields: ["RSI6", "RSI12", "RSI14", "RSI24"],
    height: 225,
  },
  { title: "ADX · 独立补充", fields: ["ADX14", "+DI", "-DI"], height: 225 },
];

export function linePoints(rows, field) {
  return rows.map((row) =>
    Number.isFinite(row[field])
      ? { time: row.date, value: row[field] }
      : { time: row.date },
  );
}

export function seriesData(rows) {
  const lines = {};
  for (const panel of PANELS) {
    for (const field of panel.fields) lines[field] = linePoints(rows, field);
  }
  return {
    candles: rows.map((row) => ({
      time: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    })),
    // volume_lots and VOL lines are already in lots. No conversion is applied here.
    volume: rows.map((row) => ({
      time: row.date,
      value: row.volume_lots,
      color: row.close >= row.open ? COLORS.histogramRise : COLORS.histogramFall,
    })),
    macd: rows.map((row) =>
      Number.isFinite(row.MACD_hist)
        ? {
            time: row.date,
            value: row.MACD_hist,
            color: row.MACD_hist >= 0 ? COLORS.histogramRise : COLORS.histogramFall,
          }
        : { time: row.date },
    ),
    lines,
  };
}

export function dateKey(time) {
  if (typeof time === "string") return time;
  if (time && typeof time === "object") {
    return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
  }
  return null;
}

export function formatValue(value, digits = 8) {
  return Number.isFinite(value)
    ? value.toLocaleString("zh-CN", { maximumFractionDigits: digits })
    : "—";
}
