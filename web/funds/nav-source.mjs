// Vendor assignment decoding and NAV event reconciliation, aligned with stock_analysis/funds.py.
import { FUND_CODE } from "./data.mjs";

const cashPlaceholder = /^(?:分红[：:])?每(?:[1-9][0-9]*)?份(?:基金份额)?派现金元$/u;
const splitPlaceholder = /^(?:拆分[：:]|折算[：:])?每(?:[1-9][0-9]*)?份(?:基金份额)?折算(?:为)?份$/u;
const roundUnit = .0001;
const dateFormat = new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai"});
const positive = (value)=>Number.isFinite(value) && value>0;

export const NAV_FIELDS = ["fS_code","fS_name","Data_netWorthTrend","Data_ACWorthTrend"];

export function assignment(source, key) {
  const match = new RegExp(`(?:^|[;\\n]|\\*/)\\s*(?:(?:var|let|const)\\s+)?${key}\\s*=\\s*`).exec(source);
  if (!match) return null;
  const start = match.index + match[0].length;
  // Find the assignment boundary outside JSON strings. JSON.parse rejects expressions.
  let quoted = false;
  let escaped = false;
  let end = start;
  for (; end<source.length; end++) {
    const character = source[end];
    if (escaped) escaped = false;
    else if (quoted && character==="\\") escaped = true;
    else if (character==='"') quoted = !quoted;
    else if (!quoted && character===";") break;
  }
  return JSON.parse(source.slice(start,end));
}

export function readNavAssignments(text) {
  return Object.fromEntries(NAV_FIELDS.map((key)=>[key,assignment(text,key)]));
}

export function offMarket(name, label="") {
  const title=name.toUpperCase();
  return !(/REIT/.test(title) || /场内|封闭式/.test(label) ||
    (title.includes("ETF") && !/联接|连接|FOF/.test(title)));
}

function categoryFor(label) {
  const value=label.trim().toUpperCase();
  if (/QDII|海外股票|海外债券/.test(value)) return "qdii";
  if (value.includes("货币")) return "money";
  if (value.includes("FOF")) return "fof";
  if (value.includes("指数")) return "index";
  for (const [prefix,category] of [["股票","stock"],["混合","mixed"],["债券","bond"]]) {
    if (value.startsWith(prefix)) return category;
  }
  return value?"other":"unknown";
}

export function parseDirectory(values) {
  if (!Array.isArray(values) || values.length>60_000) throw new Error("基金目录格式无效。");
  const catalog=new Map();
  for (const row of values) {
    if (!Array.isArray(row) || row.length<5 || !row.slice(0,5).every((item)=>typeof item==="string")) continue;
    const [code, short, name, label, pinyin]=row;
    if (FUND_CODE.test(code) && name.trim() && offMarket(name,label)) {
      catalog.set(code,{code,name:name.trim(),category:categoryFor(label),alias:`${short} ${pinyin}`});
    }
  }
  if (!catalog.size) throw new Error("基金目录没有可用记录。");
  return catalog;
}

function timestampDay(value) {
  const timestamp = new Date(value);
  if (!Number.isFinite(value) || value<0 || !Number.isFinite(timestamp.getTime())) throw new Error("基金数据源日期格式无效。");
  return dateFormat.format(timestamp);
}

function eventText(value) {
  return typeof value==="string" ? value.replace(/\s+/gu,"").replace(/[。；;]+$/u,"") : null;
}

function navEvent(value,label) {
  if (label===null) return null;
  if (!label) return value.trim()==="" ? [0,1] : null;
  const content=label.replace(/^(?:分红|拆分|折算)[：:]/u,"");
  const cash=/^每(\d+(?:\.\d+)?)?份(?:基金份额)?派现金(\d+(?:\.\d+)?)元$/u.exec(content);
  if (cash && positive(Number(cash[1]??1)) && Number.isFinite(Number(cash[2]))) {
    return [Number(cash[2])/Number(cash[1]??1),1];
  }
  const split=/^每(\d+(?:\.\d+)?)?份(?:基金份额)?折算(?:为)?(\d+(?:\.\d+)?)份$/u.exec(content);
  if (split && positive(Number(split[1]??1)) && positive(Number(split[2]))) {
    return [0,Number(split[2])/Number(split[1]??1)];
  }
  return null;
}

function growthPercent(value) {
  if (typeof value==="string" && /^[+-]?\d+(?:\.\d+)?%?$/.test(value.trim())) value=Number(value.trim().replace(/%$/,""));
  return Number.isFinite(value)?value:null;
}

function agrees(adjusted,previous,growth) {
  return Math.abs(adjusted/previous-1-growth/100)<=.00005+roundUnit*(1+Math.abs(growth/100)/2)/previous;
}

function reconcile(label,previous,nav,total,growth,splitSeen) {
  if (label===null) return {issue:"missing_event_field"};
  if (!cashPlaceholder.test(label)) return {issue:"unrecognized_event"};
  if (splitSeen) return {issue:"cash_after_split"};
  if (previous.accumulated_nav===null || total===null || growth===null) return {issue:"cash_evidence_missing"};
  const cash=Number(((total-nav)-(previous.accumulated_nav-previous.unit_nav)).toFixed(6));
  if (cash<=2*roundUnit || !agrees(nav+cash,previous.unit_nav,growth)) return {issue:"cash_evidence_mismatch"};
  return {event:[cash,1]};
}

export function fundFromAssignments(payload, code, {metadata={}, evidence={}, benchmark={}, retrievedAt=new Date()}={}) {
  if (typeof code!=="string" || !FUND_CODE.test(code) || payload.fS_code!==code) throw new Error("行情源返回了不同的基金代码。");
  const name=payload.fS_name || metadata.name;
  if (typeof name!=="string" || !name.trim() || !offMarket(name)) throw new Error("行情源没有识别到场外基金名称。");
  const trend=payload.Data_netWorthTrend;
  const totals=payload.Data_ACWorthTrend;
  if (!Array.isArray(trend) || !trend.length || trend.length>24_000) throw new Error("暂无确认单位净值，特殊净值产品可能需要独立接口。");
  if (totals!=null && (!Array.isArray(totals) || totals.length>24_000)) throw new Error("累计净值格式无效。");
  const accumulated=new Map();
  for (const item of totals??[]) {
    if (!Array.isArray(item) || item.length!==2 || !positive(item[1])) continue;
    const day=timestampDay(item[0]);
    if (accumulated.has(day)) throw new Error(`累计净值日期重复 ${day}。`);
    accumulated.set(day,item[1]);
  }
  const latestAllowed=dateFormat.format(retrievedAt);
  let index=1;
  let splitSeen=false;
  let ambiguous=0;
  const rows=[];
  for (const item of trend) {
    if (!positive(item?.y)) throw new Error("单位净值无效。");
    const day=timestampDay(item.x);
    const previous=rows.at(-1);
    if (day>latestAllowed || (previous && day<=previous.date)) throw new Error(`净值日期未来、重复或非递增 ${day}。`);
    const nav=item.y;
    const total=accumulated.get(day)??null;
    const label=eventText(item.unitMoney);
    let event=navEvent(item.unitMoney,label);
    splitSeen ||= /拆分|折算|合并/u.test(label??"") || Boolean(event && event[1]!==1);
    const growth=growthPercent(item.equityReturn);
    let amountSource=event?.[0]?"explicit":null;
    let issue=null;
    let evidenceURL=null;
    if (previous && event===null) {
      const disclosure=evidence[day];
      const reviewed=disclosure && (
        cashPlaceholder.test(label??"") && positive(disclosure.cash_per_share) ? [disclosure.cash_per_share,1] :
        splitPlaceholder.test(label??"") && positive(disclosure.shares_per_old_share) ? [0,disclosure.shares_per_old_share] : null);
      if (reviewed) {
        evidenceURL=disclosure.source;
        if (growth!==null && agrees(nav*reviewed[1]+reviewed[0],previous.unit_nav,growth)) {
          event=reviewed;
          amountSource=event[0]?"fund_disclosure":null;
        } else issue="disclosed_event_growth_mismatch";
      } else {
        const recovered=reconcile(label,previous,nav,total,growth,splitSeen);
        event=recovered.event??null;
        issue=recovered.issue??null;
        if (event) amountSource="cumulative_nav_reconciled";
      }
    }
    const [cash,split]=event??[null,null];
    let rowIndex=null;
    if (!previous) rowIndex=index;
    else if (event) {
      const multiplier=(nav*split+cash)/previous.unit_nav;
      if (growth!==null && Math.abs(multiplier-1-growth/100)>.005) issue="growth_mismatch";
      else if (positive(multiplier*index)) rowIndex=index*=multiplier;
      else issue="invalid_multiplier";
    }
    if (issue) ambiguous++;
    rows.push({date:day,unit_nav:nav,accumulated_nav:total,return_index:rowIndex,cash_distribution:cash,
      split_factor:split,cash_distribution_source:amountSource,return_issue:issue,event_evidence:evidenceURL});
  }
  const category=metadata.category??"unknown";
  const inception=metadata.inception??null;
  if (inception && rows[0].date<inception) throw new Error("净值早于基金成立日。");
  return {schema_version:1,kind:"off_market_fund",code,name:name.trim(),category,inception,manager:metadata.manager??null,
    valuation_frequency:["stock","mixed","bond","index"].includes(category)&&rows.length>=2?"daily":null,
    return_basis:"event_reinvested",return_note:ambiguous?
      `${ambiguous} 个转折点的分红、折算或净值增长率需要核实，跨越该点的区间总回报不可计算。`:
      "使用确认日净值、现金分红和份额折算构造总回报。",
    source:{name:"天天基金 / 东方财富",url:`https://fund.eastmoney.com/${code}.html`,
      method:"确认单位净值及净值序列中的现金分红 / 份额折算",retrieved_at:retrievedAt.toISOString()},
    rows,benchmark:benchmark.benchmark??null,benchmark_disclosure:benchmark.benchmark_disclosure??null,
  };
}
