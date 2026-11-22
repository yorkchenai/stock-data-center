// Presentation adapters only. Consume canonical values from either engine.
export const COLORS = {
  rise: "#cb4551",
  fall: "#168575",
  MA5: "#bd7d10",
  MA10: "#4273bc",
  MA20: "#9a5fbc",
  MA60: "#168575",
  VOL5: "#bd7d10",
  VOL10: "#4273bc",
  DIF: "#bd7d10",
  DEA: "#4273bc",
  RSI6: "#bd7d10",
  RSI12: "#4273bc",
  RSI14: "#9a5fbc",
  RSI24: "#168575",
  ADX14: "#344765",
  "+DI": "#cb4551",
  "-DI": "#168575",
};
export const PANELS = [
  { title: "价格与均线", fields: ["MA5", "MA10", "MA20", "MA60"], height: 340 },
  { title: "成交量 · 手", fields: ["VOL5", "VOL10"], height: 150 },
  { title: "MACD · 两倍柱值", fields: ["DIF", "DEA"], height: 150 },
  {
    title: "RSI · 相对强弱",
    fields: ["RSI6", "RSI12", "RSI14", "RSI24"],
    height: 150,
  },
  { title: "ADX · 独立补充", fields: ["ADX14", "+DI", "-DI"], height: 150 },
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
      color: row.close >= row.open ? COLORS.rise : COLORS.fall,
    })),
    macd: rows.map((row) =>
      Number.isFinite(row.MACD_hist)
        ? {
            time: row.date,
            value: row.MACD_hist,
            color: row.MACD_hist >= 0 ? COLORS.rise : COLORS.fall,
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
