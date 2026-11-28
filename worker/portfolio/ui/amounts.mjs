export const moneyScale = 100n;
export const unitScale = 1_000_000n;

export function fixed(value, places) {
  if (typeof value !== "string" || !new RegExp(`^\\d{1,10}(?:\\.\\d{1,${places}})?$`).test(value))
    throw new Error(`请输入非负十进制金额或份额，最多 ${places} 位小数。`);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(places, "0"));
}

export function decimal(value, places) {
  if (value === null) return null;
  const scale = 10n ** BigInt(places);
  const sign = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  return `${sign}${magnitude / scale}.${String(magnitude % scale).padStart(places,"0")}`;
}

export function rounded(numerator, denominator) {
  const sign = numerator < 0n ? -1n : 1n;
  return sign * ((numerator * sign + denominator / 2n) / denominator);
}

export const sharesValue = (shares, nav) => rounded(shares * nav * moneyScale, unitScale * unitScale);

export function redemptionNet(transaction) {
  if (transaction.received_amount!=null) return fixed(transaction.received_amount,2);
  if (transaction.confirmed_amount==null) return null;
  const amount=fixed(transaction.confirmed_amount,2);
  if (transaction.confirmed_amount_basis==="net") return amount;
  if (transaction.confirmed_amount_basis!=="gross" || transaction.fee==null) return null;
  const fee=fixed(transaction.fee,2);
  return amount>=fee?amount-fee:null;
}

export function completeTrade(type, fields) {
  if (!fields.fee) return null;
  const fee = fixed(fields.fee, 2);
  const amount = fields.amount ? fixed(fields.amount, 2) : null;
  const shares = fields.shares ? fixed(fields.shares, 6) : null;
  const nav = fields.nav ? fixed(fields.nav, 6) : null;
  if (shares===0n || nav===0n) throw new Error("交易份额和单位净值应大于零。");
  const adjustment = type==="redemption" ? -fee : fee;
  if (amount===null && shares!==null && nav!==null) {
    const proceeds = sharesValue(shares,nav)+adjustment;
    if (proceeds<0n) throw new Error("赎回手续费不能高于赎回总额。");
    return {field:"amount",value:decimal(proceeds,2)};
  }
  if (amount!==null && (shares!==null || nav!==null)) {
    const principal = amount-adjustment;
    if (principal<=0n) throw new Error("扣除或还原手续费后的份额金额应大于零。");
    if (shares!==null && nav!==null) return null;
    const value = rounded(principal*unitScale*unitScale,(shares??nav)*moneyScale);
    if (value<=0n) throw new Error("计算结果超出支持的最低精度。");
    return {field:shares===null?"shares":"nav",value:decimal(value,6)};
  }
  return null;
}
