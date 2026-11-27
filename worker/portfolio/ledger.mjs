const moneyScale = 100n;
const unitScale = 1_000_000n;
const dayMillis = 86_400_000;
const dateFormat = new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Shanghai"});

export const types = ["subscription", "redemption", "cash_dividend", "reinvestment", "conversion"];
export const statuses = ["pending", "confirmed", "cancelled"];
export const moneyFields = ["application_amount", "paid_amount", "confirmed_amount", "fee", "received_amount"];
export const unitFields = ["application_shares", "confirmed_shares", "confirmed_nav"];

export function shanghaiDay(date = new Date()) {
  return dateFormat.format(date);
}

export function validDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value >= "1900-01-01" && value <= "2199-12-31" &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}

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

function rounded(numerator, denominator) {
  const sign = numerator < 0n ? -1n : 1n;
  return sign * ((numerator * sign + denominator / 2n) / denominator);
}

const cents = (value) => value == null ? null : fixed(value,2);
const units = (value) => value == null ? null : fixed(value,6);
const asMoney = (value) => decimal(value,2);
const asUnits = (value) => decimal(value,6);
const percentage = (n,d) => n === null || d <= 0n ? null : decimal(rounded(n * 1_000_000n,d),4);
const sharesValue = (shares, nav) => rounded(shares * nav * moneyScale, unitScale * unitScale);
const isCode = (value) => typeof value === "string" && /^\d{6}$/.test(value);

function nullableText(value, max) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
    throw new Error("文本长度或格式无效。");
  return value.trim() || null;
}

export function normalizeTransaction(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !isCode(input.fund_code) ||
      !types.includes(input.type) || !statuses.includes(input.status)) throw new Error("基金代码、交易类型或状态无效。");
  const result = {fund_code:input.fund_code, fund_name:nullableText(input.fund_name,100),
    type:input.type, status:input.status, notes:nullableText(input.notes,500)};
  const applied = nullableText(input.applied_at,19)?.replace("T"," ") ?? null;
  if (applied !== null && (!validDay(applied.slice(0,10)) ||
      !/^ (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(applied.slice(10))))
    throw new Error("申请时间格式无效。");
  result.applied_at = applied && (applied.length === 16 ? applied + ":00" : applied);
  for (const key of ["confirmed_on","received_on"]) {
    const value = input[key] || null;
    if (value !== null && !validDay(value)) throw new Error("确认日或到账日期无效。");
    result[key] = value;
  }
  if (result.status === "confirmed" && !result.confirmed_on) throw new Error("已确认交易需要填写确认日期。");
  if ((result.confirmed_on && applied && applied.slice(0,10) > result.confirmed_on) ||
      (result.received_on && result.confirmed_on && result.received_on < result.confirmed_on))
    throw new Error("申请、确认和到账日期顺序无效。");
  for (const key of moneyFields) result[key] = input[key] == null || input[key] === "" ? null : asMoney(cents(input[key]));
  for (const key of unitFields) result[key] = input[key] == null || input[key] === "" ? null : asUnits(units(input[key]));
  for (const key of unitFields) if (result[key] !== null && units(result[key]) === 0n) throw new Error("已填写的份额和净值应大于零。");
  result.confirmed_amount_basis = input.confirmed_amount_basis || "unknown";
  if (!["gross","net","unknown"].includes(result.confirmed_amount_basis)) throw new Error("赎回确认金额口径无效。");
  result.related_fund_code = input.related_fund_code || null;
  if (result.related_fund_code !== null && (result.type !== "conversion" || !isCode(result.related_fund_code) ||
      result.related_fund_code === result.fund_code)) throw new Error("转换对方基金代码无效。");
  return result;
}

function redemptionNet(transaction) {
  const actual = cents(transaction.received_amount);
  const stated = cents(transaction.confirmed_amount), fee = cents(transaction.fee);
  if (actual !== null) return actual;
  if (stated !== null && transaction.confirmed_amount_basis === "net") return stated;
  if (stated !== null && fee !== null && stated >= fee && transaction.confirmed_amount_basis === "gross") return stated - fee;
  return null;
}

function recordOrder(a,b) {
  return a.confirmed_on.localeCompare(b.confirmed_on) ||
    (a.applied_at ?? a.confirmed_on).localeCompare(b.applied_at ?? b.confirmed_on) ||
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

function cashWeighted(flows, terminal, asOf, firstDate) {
  if (terminal === null || !firstDate) return null;
  const last = Date.parse(asOf);
  const period = BigInt((last - Date.parse(firstDate)) / dayMillis);
  if (period <= 0n) return null;
  let net = 0n, weighted = 0n;
  for (const {date,value} of flows) {
    net += value;
    weighted += value * BigInt((last - Date.parse(date)) / dayMillis);
  }
  return percentage((terminal-net)*period, weighted);
}

function marketNav(value) {
  try {
    const normalized = units(typeof value === "number" ? String(value) : value);
    return normalized > 0n ? normalized : null;
  } catch { return null; }
}

function sumKnown(items, key) {
  return items.some((item) => item[key] === null) ? null : items.reduce((sum,item) => sum + item[key],0n);
}

function position(code, records, complete, market, asOf) {
  const ordered = records.filter((row) => row.status === "confirmed" && row.confirmed_on <= asOf).sort(recordOrder);
  const issues = new Set();
  if (!complete) issues.add("history_not_verified");
  const flows = [], costHistory = [];
  let held = 0n, cost = 0n, invested = 0n, redeemed = 0n, received = 0n,
    dividends = 0n, realized = 0n, receivable = 0n, timingEstimated = false;
  let seenSubscription = false;
  let sharesKnown = true, costKnown = true, investedKnown = true, redeemedKnown = true,
    receivedKnown = true, dividendsKnown = true, realizedKnown = true;
  const lastConfirmed = ordered.at(-1)?.confirmed_on ?? null;
  const firstConfirmed = ordered[0]?.confirmed_on;
  const priceRows = (market?.rows ?? []).filter((row) => row.date <= asOf);
  const latest = priceRows.at(-1);
  const splits = priceRows.filter((row) => firstConfirmed && row.date >= firstConfirmed &&
    row.split_factor != null && row.split_factor !== 1);
  let split = 0;
  function checkSplit(day) {
    while (splits[split]?.date <= day) {
      if (sharesKnown && held > 0n) {
        sharesKnown = costKnown = realizedKnown = false;
        costHistory.push({date:splits[split].date,unit_cost:null});
        issues.add("share_split");
      }
      split++;
    }
  }
  for (const txn of ordered) {
    const day = txn.confirmed_on;
    checkSplit(day);
    if (!seenSubscription && (txn.type === "cash_dividend" || txn.type === "reinvestment")) {
      issues.add("unexplained_distribution");
      sharesKnown = costKnown = realizedKnown = false;
    }
    const quantity = units(txn.confirmed_shares);
    if (txn.type === "subscription" || txn.type === "reinvestment") {
      const external = txn.type === "subscription";
      const amount = cents(external ? txn.paid_amount : txn.confirmed_amount);
      if (external) {
        seenSubscription = true;
        if (amount === null) investedKnown = false;
        else {
          invested += amount;
          const cashDay = txn.applied_at?.slice(0,10) ?? day;
          timingEstimated ||= !txn.applied_at;
          flows.push({date:cashDay,value:amount});
        }
      } else {
        if (amount === null) realizedKnown = false;
        else realized += amount;
      }
      if (amount === null) {
        costKnown = false;
        issues.add("missing_purchase_amount");
      } else if (costKnown) cost += amount;
      if (quantity === null) {
        sharesKnown = costKnown = realizedKnown = false;
        issues.add("missing_confirmed_quantity");
      } else if (sharesKnown) held += quantity;
    } else if (txn.type === "redemption") {
      const net = redemptionNet(txn), actual = cents(txn.received_amount);
      if (net === null) {
        redeemedKnown = realizedKnown = false;
        issues.add("unresolved_redemption_amount");
      } else {
        redeemed += net;
        const cashDay = txn.received_on ?? day;
        timingEstimated ||= !txn.received_on;
        if (cashDay <= asOf) flows.push({date:cashDay,value:-net});
        else receivable += net;
      }
      if (actual === null) receivedKnown = false;
      else if (!txn.received_on || txn.received_on <= asOf) received += actual;
      if (quantity === null || !sharesKnown || quantity > held) {
        if (quantity === null) issues.add("missing_confirmed_quantity");
        else if (sharesKnown) issues.add("insufficient_prior_shares");
        sharesKnown = costKnown = realizedKnown = false;
      } else {
        const removedCost = costKnown ? rounded(cost * quantity,held) : null;
        held -= quantity;
        if (removedCost !== null) {
          cost -= removedCost;
          if (net !== null) realized += net - removedCost;
        } else realizedKnown = false;
      }
    } else if (txn.type === "cash_dividend") {
      const amount = cents(txn.received_amount ?? txn.confirmed_amount);
      if (amount === null) {
        dividendsKnown = realizedKnown = false;
        issues.add("missing_dividend_amount");
      } else {
        dividends += amount;
        realized += amount;
        const cashDay = txn.received_on ?? day;
        timingEstimated ||= !txn.received_on;
        if (cashDay <= asOf) flows.push({date:cashDay,value:-amount});
        else receivable += amount;
      }
    } else {
      sharesKnown = costKnown = investedKnown = redeemedKnown = receivedKnown = dividendsKnown = realizedKnown = false;
      issues.add("conversion_unposted");
    }
    if (sharesKnown && costKnown && complete) {
      const entry = {date:day,unit_cost:held ? asUnits(rounded(cost * unitScale * unitScale,held * moneyScale)) : null};
      if (costHistory.at(-1)?.date === day) costHistory[costHistory.length-1] = entry;
      else costHistory.push(entry);
    }
  }
  checkSplit(asOf);
  if (!complete) sharesKnown = costKnown = investedKnown = redeemedKnown = receivedKnown = dividendsKnown = realizedKnown = false;
  const nav = marketNav(latest?.unit_nav);
  if (held > 0n && !nav) issues.add("nav_unavailable");
  const historicalNav = Boolean(lastConfirmed && latest && latest.date < lastConfirmed && held > 0n);
  const value = !sharesKnown || historicalNav ? null : held === 0n ? 0n : nav !== null ? sharesValue(held,nav) : null;
  const holdingCost = costKnown ? cost : null;
  const floating = value !== null && holdingCost !== null && !historicalNav ? value - holdingCost : null;
  const realizedYuan = realizedKnown ? realized : null;
  const total = floating !== null && realizedYuan !== null ? floating+realizedYuan : null;
  if (historicalNav) issues.add("nav_before_latest_trade");
  const estimation = market?.estimate ?? null;
  const estNav = latest?.date < asOf && estimation?.updated_at?.slice(0,10) === asOf
    ? marketNav(estimation.unit_nav) : null;
  const estimatedValue = value !== null && estNav !== null && !historicalNav ? sharesValue(held,estNav) : null;
  const estimatedPnl = estimatedValue !== null ? estimatedValue - value : null;
  const firstDate = flows.map((row)=>row.date).sort()[0];
  const terminal = total !== null && !historicalNav ? value+receivable : null;
  return {code, name:records.findLast((txn)=>txn.fund_name)?.fund_name ?? market?.name ?? code, issues:[...issues],
    shares:sharesKnown ? held : null, market_value:value, holding_cost:holdingCost, floating_pnl:floating, realized_pnl:realizedYuan,
    total_pnl:total, invested:investedKnown ? invested : null, redeemed_net:redeemedKnown ? redeemed : null,
    redeemed_received:receivedKnown ? received : null, dividends:dividendsKnown ? dividends : null,
    estimates:estNav === null ? null : {...estimation,market_value:asMoney(estimatedValue),pnl:asMoney(estimatedPnl)},
    estimated_pnl:sharesKnown && held === 0n ? 0n : estimatedPnl,
    nav:nav !== null ? {unit_nav:asUnits(nav),date:latest.date,source:market.source} : null,
    simple_return:historicalNav || !investedKnown ? null : percentage(total,invested),
    weighted_return:cashWeighted(flows,terminal,asOf,firstDate),
    cashflow_dates_estimated:timingEstimated, cost_history:costHistory,
    flows, terminal};
}

const moneyMetrics = ["market_value","holding_cost","floating_pnl","realized_pnl","total_pnl","invested",
  "redeemed_net","redeemed_received","dividends","estimated_pnl"];

export function calculatePortfolio(records, settings, markets, asOf = shanghaiDay()) {
  const groups = new Map();
  for (const txn of records) {
    if (txn.deleted_at) continue;
    if (!groups.has(txn.fund_code)) groups.set(txn.fund_code,[]);
    groups.get(txn.fund_code).push(txn);
    if (txn.type === "conversion" && txn.related_fund_code && txn.status === "confirmed") {
      if (!groups.has(txn.related_fund_code)) groups.set(txn.related_fund_code,[]);
      groups.get(txn.related_fund_code).push({...txn,fund_code:txn.related_fund_code,fund_name:null});
    }
  }
  const known = new Map(settings.map((row)=>[row.fund_code, row.history_complete]));
  const products = [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([code,rows]) =>
    position(code,rows,known.get(code) === true,markets.get(code),asOf));
  const totals = Object.fromEntries(moneyMetrics.map((key)=>[key,sumKnown(products,key)]));
  const terminal = sumKnown(products,"terminal");
  const flows = products.flatMap((product)=>product.flows);
  const firstDate = flows.map((row)=>row.date).sort()[0];
  return {as_of:asOf,
    totals:{...Object.fromEntries(moneyMetrics.map((key)=>[key,asMoney(totals[key])])),
      simple_return:terminal === null || totals.invested === null ? null : percentage(totals.total_pnl,totals.invested),
      weighted_return:cashWeighted(flows,terminal,asOf,firstDate),
      cashflow_dates_estimated:products.some((product)=>product.cashflow_dates_estimated)},
    funds:products.map(({flows,terminal,market_value,shares,total_pnl,...product})=>({...product,
      ...Object.fromEntries(moneyMetrics.map((key)=>[key,asMoney(key==="market_value"?market_value:key==="total_pnl"?total_pnl:product[key])])),
      shares:asUnits(shares),
      units_known:shares !== null,
      weight:market_value === null || totals.market_value === null ? null : percentage(market_value,totals.market_value),
      contribution_share:totals.total_pnl === null || totals.total_pnl === 0n || total_pnl === null ? null :
        (totals.total_pnl > 0n ? percentage(total_pnl,totals.total_pnl) : percentage(-total_pnl,-totals.total_pnl)),
      history_complete:known.get(product.code) === true}))};
}
