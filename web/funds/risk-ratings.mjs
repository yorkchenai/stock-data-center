// Each upper bound is exclusive and uses the full-precision metric value.
export const RISK_RATINGS = {
  volatility:[
    [0.05,"极低波动","dark-green"],[0.10,"低波动","light-green"],[0.20,"中等波动","yellow"],
    [0.30,"较高波动","orange"],[0.40,"高波动","dark-orange"],[0.50,"很高波动","red"],[Infinity,"极高波动","dark-red"],
  ],
  sharpe:[
    [0,"低于参考收益","dark-red"],[0.5,"较差","red"],[1,"一般","orange"],[1.5,"较好","light-green"],
    [2,"良好","green"],[3,"优秀","dark-green"],[Infinity,"非常高","dark-green"],
  ],
  sortino:[
    [0,"未达目标","dark-red"],[0.5,"偏低","red"],[1,"一般","orange"],[2,"较好","light-green"],
    [3,"优秀","green"],[Infinity,"非常高","dark-green"],
  ],
};

export function riskRating(id, value) {
  if (!Number.isFinite(value) || (id==="volatility" && value<0)) return null;
  return RISK_RATINGS[id]?.find(([upper])=>value<upper) ?? null;
}

export function riskRatingRange(id, index) {
  const bands = RISK_RATINGS[id];
  const lower = bands[index-1]?.[0] ?? (id==="volatility" ? 0 : -Infinity);
  const upper = bands[index][0];
  const format = (value)=>id==="volatility" ? (100*value).toFixed(0)+"%" : value.toFixed(1);
  if (lower===-Infinity) return `< ${format(upper)}`;
  if (upper===Infinity) return `≥ ${format(lower)}`;
  return `${format(lower)} ≤ 数值 < ${format(upper)}`;
}
