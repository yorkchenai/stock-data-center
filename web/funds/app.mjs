import { FUND_CATEGORIES, FUND_CODE, MAX_FILE_BYTES, fundFreshness, normalizeFund, searchCatalog, shanghaiToday } from "./data.mjs";
import { FUND_RISK_REFERENCE, PERIODS, analyzePerformance, periodReturn, periodStart, selectWindow } from "./performance.mjs";
import { RISK_RATINGS, riskRating, riskRatingRange } from "./risk-ratings.mjs";
import { createFundCharts } from "./charts.mjs";
import { BUNDLE_BYTES, normalizeChartFile } from "./chart-data.mjs";
import { createNavChart } from "./nav-chart.mjs";
import { fetchFund, fetchFundDirectory, readPageData } from "./providers.mjs";
import { watchValuation } from "./valuation.mjs";
import { browserModelVersion, getPageSnapshot, snapshotNote, snapshotsEnabled } from "../snapshot-client.mjs";

const $ = (id) => document.getElementById(id);
function tag(name, text, attrs = {}) {
  const element = document.createElement(name);
  if (text != null) element.textContent = text;
  for (const [key,value] of Object.entries(attrs)) element.setAttribute(key,value);
  return element;
}
function status(id, text, error = false) {
  $(id).textContent = text;
  $(id).dataset.state = error ? "error" : "";
}
const pct = (v) => (100 * v).toFixed(2) + "%";
const estimatePct = (v) => (v>0 ? "+" : "") + v.toFixed(2) + "%";
const decimal = (v) => v.toFixed(2);
const nav = (v) => v.toFixed(4);
const shown = (v, format) => v == null ? "—" : format(v);
const describe = (v) => FUND_CATEGORIES[v] ?? FUND_CATEGORIES.unknown;
const key = "stock-data-center.off-market-funds.v1";
const loaded = new Map();
const catalog = new Map();
const beingLoaded = new Map();
const listNavRequests = new Set();
const listNavErrors = new Map();
const maxListNavRequests = 3;
const sharedSnapshots = new Map();
const snapshotFallback = new Map();
const valuationLabels = new Map([["fundgz","估值1"],["sina_ds2","估值2"],["sina_ds3","估值3"]]);
const columns = [
  ["name","基金名称 / 代码"],["type","基金类型"],...valuationLabels,["nav","最新单位净值"],["date","净值日期"],...PERIODS,
  ["source","来源"],["actions","操作"],
];
const optionalColumns = columns.filter(([id])=>!["name","actions"].includes(id));
const detailPeriods = [...PERIODS.slice(1),["all","全部历史"],["custom","自定义"]];
const coreDefinitions = [
  ["return","区间收益率",pct,"区间末总回报指数相对起点的变化。"],
  ["drawdown","最大回撤",pct,"区间内总回报指数从峰值到谷底的最大跌幅。"],
  ["sharpe","夏普比率",decimal],
  ["volatility","年化波动率",pct],
  ["sortino","索提诺比率",decimal],
];
const riskSessions = FUND_RISK_REFERENCE.observations_per_year;
const annualReference = new Intl.NumberFormat("zh-CN",{style:"percent",maximumFractionDigits:4})
  .format(FUND_RISK_REFERENCE.annual_rate);
const dailyReferenceFormula = `日参考收益率 = (1 + ${annualReference}) ^ (1 / ${riskSessions}) − 1。`;
const riskFormulas = {
  volatility:`日收益的样本标准差 × √${riskSessions}。数值越高，日常涨跌越大。`,
  sharpe:`（平均日收益 − 日参考收益率）÷ 日收益的样本标准差 × √${riskSessions}。${dailyReferenceFormula}`,
  sortino:`（平均日收益 − 日参考收益率）÷ 下行偏差 × √${riskSessions}。${dailyReferenceFormula} 最低可接受收益率（MAR）为年化 ${annualReference}。下行偏差是各日低于参考收益率的差额的均方根，达到参考值的日期按零计入。`,
};
$("risk-reference-note").textContent = `夏普比率及索提诺比率采用固定年化参考收益率${annualReference}计算，年化基数为${riskSessions}个交易日。评价等级为系统自定义经验标准，不构成投资建议。`;
const charts = createFundCharts();
const navChart = createNavChart($("nav-chart"),$("nav-hover"),$("nav-extremes"));
let navMode = "adjusted";
let navRange = [];
const loopback = ["127.0.0.1","localhost","[::1]"].includes(location.hostname);
const online = document.documentElement.dataset.mode==="pages";
let pageConfig;
function fetchPageConfig() {
  if (!pageConfig) {
    pageConfig=readPageData("fund-config.json").then((config)=>{
      if (config.schema_version!==1) throw new Error("基金网页配置资料不完整。");
      return config;
    }).catch((error)=>{pageConfig=null;throw error;});
  }
  return pageConfig;
}
let pageDisclosures;
function fetchPageDisclosures() {
  pageDisclosures ??= readPageData("fund-benchmark-disclosures.json").then((data)=>
    data.schema_version === 1 ? data.disclosures : null).catch(()=>null);
  return pageDisclosures;
}
const url = (code) => new URL(code ? `?fund=${code}` : "funds.html", location.href);
const localURL = (path) => new URL("/api/funds" + path, location.origin);
const noData = "未载入可用净值。";
let local = false;
let routeNumber = 0;
let searchNumber = 0;
let selectedCode = null;
let rangeKey = "1y";
let historyLimit = 60;

function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}");
    return {
      list:Array.isArray(raw.list) ? raw.list.filter((v)=>typeof v?.code==="string" && FUND_CODE.test(v.code)) : [],
      hidden:Array.isArray(raw.hidden) ? raw.hidden : [],
      favorites:raw.favorites===true,
      type:Object.hasOwn(FUND_CATEGORIES,raw.type) ? raw.type : "",
      sort:columns.some(([id])=>id===raw.sort && id!=="actions") ? raw.sort : "name",
      descending:raw.descending===true,
    };
  } catch {
    return {list:[],hidden:[],favorites:false,type:"",sort:"name",descending:false};
  }
}
const state = restore();
for (const row of state.list) catalog.set(row.code,row);
function save() {
  try { localStorage.setItem(key,JSON.stringify(state)); }
  catch { status("list-status","当前浏览器无法保存列表设置，本次会话仍可使用。",true); }
}

function recordFund(fund) {
  const record = {code:fund.code,name:fund.name,category:fund.category};
  const saved = state.list.find((entry)=>entry.code===record.code);
  if (saved) Object.assign(saved,record);
  loaded.set(fund.code,fund);
  catalog.set(record.code,record);
}
function addFund(record) {
  if (state.list.some((entry)=>entry.code===record.code)) return;
  state.list.push({code:record.code,name:record.name,category:record.category,favorite:false});
  catalog.set(record.code,record);
  save();
}
async function readApi(path) {
  const response = await fetch(localURL(path), {cache:"no-store", signal:AbortSignal.timeout(19_000)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "基金接口暂不可用。");
  return data;
}
async function loadOnlineFund(code, snapshotId) {
  snapshotFallback.delete(code);
  if (snapshotsEnabled) {
    try {
      const snapshot=await getPageSnapshot({asset_type:"fund",symbol:code},snapshotId);
      if (!snapshot.data.risk?.windows?.["1y"]?.metrics) throw new Error("共享快照缺少基金风险结果。");
      const reference = snapshot.data.risk.reference;
      if (reference?.annual_rate!==FUND_RISK_REFERENCE.annual_rate ||
          reference?.observations_per_year!==riskSessions || !Number.isFinite(reference?.daily_rate) ||
          Math.abs(reference.daily_rate-FUND_RISK_REFERENCE.daily_rate)>1e-15) {
        throw new Error("共享快照的风险参考收益率与网页不一致。");
      }
      if (!snapshotId && snapshot.data.fund.valuation_frequency==="daily" &&
          Date.parse(shanghaiToday())-Date.parse(snapshot.data_as_of)>7*86_400_000) {
        throw new Error("共享快照净值日期已超过 7 天。");
      }
      return {raw:snapshot.data.fund,snapshot};
    } catch (error) {
      if (snapshotId) throw error;
      snapshotFallback.set(code,error.name==="TimeoutError"?"共享快照加载超时":error.message);
    }
  } else if (snapshotId) throw new Error("此页面未配置该共享快照服务。");
  return {raw:await fetchFund(code,await fetchPageConfig()),snapshot:null};
}
function loadFund(code,snapshotId=null) {
  const key=snapshotId??code;
  if (!beingLoaded.has(key)) {
    const before = loaded.get(code);
    const pending=online?loadOnlineFund(code,snapshotId):readApi("/" + code).then((raw)=>({raw}));
    const disclosures = (online || local) ? fetchPageDisclosures() : null;
    beingLoaded.set(key,Promise.all([pending,disclosures]).then(([{raw,snapshot},reviewed])=>{
      const fund = normalizeFund(raw);
      if (fund.code !== code) throw new Error("查询结果的基金代码不一致。");
      if (!snapshotId && loaded.has(code) && loaded.get(code)!==before) return loaded.get(code);
      fund.reviewedBenchmark = reviewed?.[code];
      if (snapshot) sharedSnapshots.set(code,snapshot);
      else sharedSnapshots.delete(code);
      recordFund(fund);
      save();
      return fund;
    }).finally(()=>beingLoaded.delete(key)));
  }
  return beingLoaded.get(key);
}
async function loadListFund(code) {
  status("list-status",`正在载入 ${code} 的确认净值…`);
  try {await loadFund(code);listNavErrors.delete(code);status("list-status",`已载入 ${code}。`);}
  catch (error) {listNavErrors.set(code,error.message);status("list-status",error.message,true);}
  renderList();
}
function loadVisibleListFunds(rows) {
  if (selectedCode || !(local || online)) return;
  for (const {code} of rows) {
    if (listNavRequests.size>=maxListNavRequests) break;
    if (loaded.has(code) || listNavRequests.has(code) || listNavErrors.has(code)) continue;
    listNavRequests.add(code);
    void loadFund(code).catch((error)=>listNavErrors.set(code,error.message)).finally(()=>{
      listNavRequests.delete(code);
      if (!selectedCode) renderList();
    });
  }
}
function estimateValue(quote) {
  return {value:quote?.change ?? null,format:estimatePct,reason:quote ? "" : "暂无当日估值",percent:true};
}
function paintValue(cell,{value,format,reason,percent},suffix="") {
  cell.textContent = shown(value,format ?? String)+suffix;
  cell.title = reason ?? "";
  cell.className = reason ? "fund-missing" : percent && value ? (value>0 ? "fund-positive" : "fund-negative") : "";
}
function tableValue(id, row, fund, estimates) {
  if (id==="name") return {value:row.name};
  if (id==="type") return {value:describe(row.category)};
  if (valuationLabels.has(id)) return estimateValue(estimates.find((quote)=>quote.id===id));
  if (!fund) {
    const loading = listNavRequests.has(row.code);
    const error = listNavErrors.get(row.code);
    const reason = loading ? "正在载入确认净值。" : error ? `${error} 请点击行内「载入」重试。` : "尚未载入确认净值。";
    return {value:null,reason};
  }
  const latest = fund.rows.at(-1);
  if (id==="nav") return {value:latest.unit_nav,format:nav};
  if (id==="date") return {value:latest.date};
  if (id==="source") return {value:fund.source.name};
  const snapshot = sharedSnapshots.get(row.code);
  const result = snapshot
    ? snapshot.data.risk?.returns?.[id] ?? {value:null,reason:"共享快照缺少该周期收益。"}
    : periodReturn(fund,id);
  return {...result,format:pct,percent:true};
}
function visibleColumns() { return columns.filter(([id])=>!state.hidden.includes(id) || ["name","actions"].includes(id)); }
function renderList() {
  const active = visibleColumns();
  $("show-all").setAttribute("aria-pressed",String(!state.favorites));
  $("show-favorites").setAttribute("aria-pressed",String(state.favorites));
  const header = tag("tr");
  for (const [id,label] of active) {
    const sorted = state.sort===id;
    const th = tag("th",null,{scope:"col","data-column":id});
    if (valuationLabels.has(id)) th.dataset.estimate = id;
    if (id==="actions") th.textContent = label;
    else {
      if (sorted) th.setAttribute("aria-sort",state.descending ? "descending" : "ascending");
      const button = tag("button",label + (sorted ? state.descending ? " ↓" : " ↑" : ""),{type:"button"});
      button.addEventListener("click",()=>{
        state.descending = state.sort===id ? !state.descending : valuationLabels.has(id) || PERIODS.some(([period])=>period===id);
        state.sort = id;
        save();
        renderList();
      });
      th.append(button);
    }
    header.append(th);
  }
  $("fund-table").tHead.replaceChildren(header);
  const rows = state.list.filter((entry)=>(!state.favorites || entry.favorite) && (!state.type || state.type===entry.category));
  loadVisibleListFunds(rows);
  const items = rows.map((row)=>{
    const fund = loaded.get(row.code);
    const estimates = fund?.mode==="synthetic" ? [] : valuation.quotes(row.code);
    const entries = Object.fromEntries(active.filter(([id])=>id!=="actions").map(([id])=>[id,tableValue(id,row,fund,estimates)]));
    return {row,fund,entries};
  });
  items.sort((a,b)=>{
    const left = a.entries[state.sort]?.value;
    const right = b.entries[state.sort]?.value;
    if (left == null || right == null) return Number(left==null)-Number(right==null) || a.row.code.localeCompare(b.row.code);
    const diff = typeof left==="number" && typeof right==="number" ? left-right : String(left).localeCompare(String(right),"zh-CN");
    return (state.descending ? -diff : diff) || a.row.code.localeCompare(b.row.code);
  });
  const target = $("fund-table").tBodies[0];
  const estimateCodes = !selectedCode && (local || online) && active.some(([id])=>valuationLabels.has(id))
    ? items.filter(({fund})=>fund?.mode!=="synthetic").map(({row})=>row.code) : [];
  if (!items.length) {
    const message = state.list.length ? "当前筛选下没有基金。" : "搜索并添加基金，或导入确认净值 JSON。";
    target.replaceChildren(tag("tr"));
    target.firstChild.append(tag("td",message,{colspan:active.length,class:"empty-cell"}));
    if (!selectedCode) valuation.select(estimateCodes);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const {row,entries,fund} of items) {
    const tr = tag("tr",null,{"data-fund-code":row.code});
    for (const [id] of active) {
      const td = tag("td",null,{"data-column":id});
      if (valuationLabels.has(id)) td.dataset.estimate = id;
      if (id==="name") {
        const link = tag("a",row.name ?? row.code,{href:url(row.code),title:row.name ?? row.code});
        link.addEventListener("click",navigateLink);
        td.append(link,tag("small",row.code + (fund?.mode==="synthetic" ? " · 测试数据" : "")));
      } else if (id==="actions") {
        const star = tag("button",row.favorite ? "★" : "☆",{"aria-label":`${row.favorite ? "取消自选" : "加入自选"} ${row.code}`,"aria-pressed":String(Boolean(row.favorite))});
        star.addEventListener("click",()=>{row.favorite=!row.favorite;save();renderList();});
        const remove = tag("button","移除",{"aria-label":`移除 ${row.code}`});
        remove.addEventListener("click",()=>{state.list=state.list.filter((entry)=>entry.code!==row.code);save();renderList();});
        td.append(star," ",remove);
        if (local || online) {
          const refresh = tag("button",fund ? "刷新" : "载入",{"aria-label":`载入 ${row.code} 的净值`});
          refresh.disabled = listNavRequests.has(row.code);
          refresh.addEventListener("click",()=>{refresh.disabled=true;void loadListFund(row.code);});
          td.append(" ",refresh);
        }
      } else {
        paintValue(td,entries[id],id==="date" && fund?.mode==="synthetic" ? " · 测试" : "");
        if (id==="nav" && !fund) {
          if (listNavRequests.has(row.code)) td.textContent = "载入中…";
          else if (listNavErrors.has(row.code)) td.textContent = "载入失败";
        }
      }
      tr.append(td);
    }
    fragment.append(tr);
  }
  target.replaceChildren(fragment);
  if (!selectedCode) valuation.select(estimateCodes);
}

function renderSearch(results, term) {
  if (!results.length) {
    $("search-result").replaceChildren(tag("p","当前目录未找到匹配项。",{class:"fund-note"}));
    return;
  }
  const list = tag("ul");
  for (const entry of results) {
    const row = tag("li");
    const add = tag("button","添加",{type:"button"});
    add.disabled = state.list.some(({code})=>code===entry.code);
    if (add.disabled) add.textContent="已添加";
    add.addEventListener("click",async ()=>{
      addFund(entry);
      add.disabled=true;
      add.textContent="已添加";
      renderList();
      if ((local || online) && !loaded.has(entry.code)) {
        await loadListFund(entry.code);
      } else if (!loaded.has(entry.code)) status("list-status",`已添加 ${entry.code}。请导入该基金确认净值 JSON。`);
      else status("list-status",`已添加 ${entry.code}。`);
    });
    row.append(tag("span",`${entry.name ?? "待核实名称"} · ${entry.code} · ${describe(entry.category)}`),add);
    list.append(row);
  }
  $("search-result").replaceChildren(list);
  if (FUND_CODE.test(term) && !local && !online && !loaded.has(term)) {
    $("search-result").append(tag("p","可按代码登记。导入确认净值后显示名称与收益。",{class:"fund-note"}));
  }
}

const missingFact = ([,value,sourceUrl]) => value == null && !sourceUrl;
function showFacts(target, fields) {
  target.replaceChildren(...fields.flatMap((field)=>{
    const [name,value,sourceUrl] = field;
    const attrs = missingFact(field) ? {class:"fact-missing"} : {};
    const description = tag("dd",value ?? "—",attrs);
    if (typeof sourceUrl === "string" && URL.canParse(sourceUrl) && new URL(sourceUrl).protocol === "https:") {
      description.append(" ",tag("a","查看来源",{href:sourceUrl,target:"_blank",rel:"noopener noreferrer"}));
    }
    return [tag("dt",name,attrs),description];
  }));
}
function renderHoldings(fund) {
  const target = $("holdings-data");
  const holdings = fund?.holdings;
  if (!holdings?.period_end || !holdings?.disclosed_at || !holdings?.source) {
    target.replaceChildren(tag("p","暂无带报告期和披露日期的可信持仓资料。",{class:"fund-note"}));
    return;
  }
  const details = tag("dl",null,{class:"fund-facts"});
  showFacts(details,[["报告期",holdings.period_end],["披露日期",holdings.disclosed_at],["来源",holdings.source],
    ["资产配置",holdings.allocation],["主要持仓",holdings.top],["行业分布",holdings.industries],
    ["投资主题",holdings.theme],["集中度",holdings.concentration]]);
  target.replaceChildren(details);
}
function historyTable(fund) {
  const target = $("nav-history").tBodies[0];
  const rows = (fund?.rows ?? []).slice(-historyLimit).reverse();
  target.replaceChildren(...rows.map((row)=>{
    const tr = tag("tr");
    for (const v of [row.date,shown(row.unit_nav,nav),shown(row.accumulated_nav,nav),
      shown(row.return_index,nav),shown(row.cash_distribution,nav)]) tr.append(tag("td",v));
    return tr;
  }));
  $("show-more-history").hidden = !fund || fund.rows.length<=historyLimit;
}
const formatFormula = (formula) => formula.replace(/\s*[＋+]\s*/g," + ").replace(/\s*[×*]\s*/g," × ");
function disclosureDates(version) {
  const parts = [];
  for (const [kind,label,date] of [
    ["published","披露日期",version.disclosed_on],
    ["effective",version.start_basis ? "已核实起始日" : "生效日期",version.effective_from],
  ]) {
    if (parts.length) parts.push(" · ");
    parts.push(label + " ",date ? tag("time",date,{datetime:date,"data-date-kind":kind}) : "未披露");
  }
  if (version.effective_to) parts.push(" · 截至 ",tag("time",version.effective_to,{datetime:version.effective_to}));
  for (const [label,url] of [["查看官方披露",version.source_url],["管理人页面",version.manager_url]]) {
    if (typeof url !== "string" || !URL.canParse(url)) continue;
    const link = new URL(url);
    if (link.protocol === "https:" && !link.username && !link.password) {
      parts.push(" · ",tag("a",label,{href:link.href,target:"_blank",rel:"noopener noreferrer"}));
    }
  }
  return parts;
}
function renderBenchmark(fund, today) {
  const benchmark = fund?.benchmark;
  const disclosure = fund?.benchmark_disclosure;
  const reviewed = fund?.reviewedBenchmark;
  const known = (reviewed?.versions ?? []).filter(({effective_from})=>effective_from<=today);
  const latest = known.at(-1);
  const regime = benchmark?.regimes.filter(({effective_from,method})=>effective_from<=today && method!=="none").at(-1);
  const fallback = disclosure ?? (benchmark && {
    ...regime, formula:regime?.formula ?? benchmark.formula, name:benchmark.name,
    source_url:regime?.source_url ?? benchmark.source_url,
  });
  const version = latest ?? fallback;
  const formula = version?.formula;
  const main = formula && (/\d\s*[%％]/.test(formula) || !version.name) ? formula : version?.name;
  $("benchmark-disclosure").textContent = main ? formatFormula(main) : "业绩比较基准暂未核实";

  const validity = $("benchmark-validity");
  validity.hidden = !main || (version.current_verified && (!version.effective_to || today<=version.effective_to));
  validity.textContent = validity.hidden ? "" : "当前有效性待核实";
  const source = $("benchmark-source");
  source.hidden = !main;
  source.replaceChildren(...(main ? disclosureDates(version) : []));

  const previous = known.filter((item)=>item!==version).reverse();
  $("benchmark-history").hidden = !previous.length;
  $("benchmark-history").open = false;
  $("benchmark-history-list").replaceChildren(...previous.map((item)=>{
    const row = tag("li",formatFormula(item.formula));
    const dates = tag("p",null,{class:"fund-note"});
    dates.append(...disclosureDates(item));
    row.append(dates);
    return row;
  }));

  const tracking = $("tracking-index");
  const target = reviewed?.tracking_index ?? disclosure?.tracking_index ?? fund?.related.find(({kind})=>kind==="official_tracking");
  tracking.hidden = !target?.name;
  tracking.textContent = target?.name ? "跟踪指数 · " + target.name : "";
}
function renderDetailValuation(quotes,message,pending) {
  $("valuation-refresh").disabled = pending;
  const text = [message,quotes.length || pending ? "" : "暂无当日估值"].filter(Boolean).join(" · ");
  $("valuation-status").textContent = text;
  $("valuation-status").hidden = !text;
  $("valuation-quotes").replaceChildren(...quotes.map(({id,change})=>{
    const item = tag("article",null,{class:"risk-metric","data-valuation-source":id});
    item.append(tag("span",valuationLabels.get(id)),tag("strong",estimatePct(change)));
    return item;
  }));
}
const valuation = watchValuation((code,quotes,message,pending)=>{
  if (selectedCode) {
    if (selectedCode===code) renderDetailValuation(quotes,message,pending);
    return;
  }
  if (!pending && valuationLabels.has(state.sort)) renderList();
  for (const cell of $("fund-table").querySelectorAll(`tr[data-fund-code="${code}"] td[data-estimate]`)) {
    const quote = quotes.find(({id})=>id===cell.dataset.estimate);
    paintValue(cell,estimateValue(quote));
    if (quote && !pending && message) cell.title = message;
  }
},online ? document.documentElement.dataset.analysisOrigin : null);
function showValuation(code) {
  $("valuation-panel").hidden = !code;
  renderDetailValuation(valuation.quotes(code),"",false);
  valuation.select(code ? [code] : []);
}
function renderIdentity(code,fund) {
  const entry = catalog.get(code);
  $("fund-title").textContent = fund?.name ?? entry?.name ?? "基金 " + code;
  $("fund-identity").textContent = `${code} · ${describe(fund?.category ?? entry?.category)} · 基金管理人 ${fund?.manager ?? "—"}`;
  const latest = fund?.rows.at(-1);
  $("fund-nav").textContent = shown(latest?.unit_nav,nav);
  $("fund-nav-date").textContent = latest?.date ?? "—";
  const shared = fund && sharedSnapshots.get(code);
  const origin = shared ? snapshotNote(shared) : online && fund ?
    `网页独立数据 · 截至 ${latest.date} · ${browserModelVersion}${snapshotFallback.has(code)
      ? " · " + snapshotFallback.get(code):""}` : "";
  $("fund-source").textContent = "来源 " + (fund?.source.name ?? "—") + (origin?" · "+origin:"");
  $("fund-freshness").textContent = "状态 " + (fund ? fundFreshness(fund) : "未载入");
  renderBenchmark(fund,shanghaiToday());
  const sourceTime = fund && new Intl.DateTimeFormat("zh-CN",{
    timeZone:"Asia/Shanghai",dateStyle:"medium",timeStyle:"short",
  }).format(new Date(fund.source.retrieved_at));
  const facts = [["基金成立日期",fund?.inception],["基金规模",fund?.size],["费率",fund?.fee],
    ["基金经理",fund?.fund_manager],["数据获取时间（上海）",sourceTime],
    ["原始数据口径",fund?.source.method],["总回报口径",fund?.return_note ?? (fund?.return_basis==="adjusted_nav" ? "来源提供的复权总回报序列" : null)]];
  showFacts($("fund-more"),facts);
  const missing = facts.filter(missingFact);
  const missingDetails = $("fund-missing-facts");
  missingDetails.hidden = !missing.length;
  missingDetails.open = false;
  missingDetails.querySelector("summary").textContent = `未取得的基金信息（${missing.length} 项）`;
  showFacts($("fund-missing-fact-list"),missing);
  renderHoldings(fund);
  historyTable(fund);
  const first = fund?.rows[0].date ?? "";
  for (const id of ["fund-start","fund-end"]) {
    $(id).min = first;
    $(id).max = latest?.date ?? shanghaiToday();
  }
  $("fund-start").value = first;
  $("fund-end").value = latest?.date ?? "";
}
function ratingBadge([,label,color]) {
  return tag("span",label,{class:"risk-rating","data-rating-color":color});
}
function riskMetricHeading(id,label,tagName) {
  const bands = RISK_RATINGS[id];
  if (!bands) return tag(tagName,label);
  const details = tag("details",null,{class:"risk-metric-help"});
  const ranges = tag("dl",null,{class:"risk-rating-ranges"});
  bands.forEach((band,index)=>{
    const rating = tag("dd");
    rating.append(ratingBadge(band));
    ranges.append(tag("dt",riskRatingRange(id,index)),rating);
  });
  details.append(tag("summary",label),tag("p",riskFormulas[id]),ranges);
  return details;
}
function metricResult(id,value,format) {
  const result = tag("div",null,{class:"metric-result"});
  result.append(tag("strong",shown(value,format)));
  const rating = riskRating(id,value);
  if (rating) result.append(ratingBadge(rating));
  return result;
}

function renderAnalysis(requestedStart, requestedEnd) {
  const fund = loaded.get(selectedCode);
  const latest = fund?.rows.at(-1).date;
  let range = {error:noData,rows:[]};
  let chartStart, chartEnd;
  if (fund) {
    const start = requestedStart ?? (rangeKey==="all" ? null : rangeKey==="custom" ? $("fund-start").value : periodStart(latest,rangeKey));
    const end = requestedEnd ?? (rangeKey==="custom" ? $("fund-end").value : latest);
    chartStart=start;
    chartEnd=end;
    try {
      range = end>latest ? {error:"结束日期超出已载入历史。",rows:[]} : selectWindow(fund,start,end);
    } catch (error) {range={error:error.message,rows:[]};}
  }
  navRange=[chartStart,chartEnd];
  renderNav(fund,...navRange);
  const shared=sharedSnapshots.get(selectedCode);
  const precomputed=!requestedStart && !requestedEnd && shared?.data.risk?.windows[rangeKey];
  const analysis=precomputed || analyzePerformance(fund,range);
  const {start: statsStart, end: statsEnd} = precomputed || range;
  const interval = statsStart ? `${statsStart} 至 ${statsEnd}` : "—";
  const unavailable = precomputed ? (statsStart ? null : precomputed.metrics.return.reason) : range.error;
  $("range-status").textContent = unavailable ?? `统计范围 ${interval} · 已载入净值 ${fund.rows[0].date} 至 ${latest}`;
  $("core-metrics").replaceChildren(...coreDefinitions.map(([id,label,format,description])=>{
    const article = tag("article",null,{class:"metric","data-metric":id,...(description ? {title:description} : {})});
    const metric = analysis.metrics[id];
    const note = tag("small",metric.reason ?? interval);
    if (!metric.reason && statsStart) {
      note.replaceChildren(tag("time",statsStart,{datetime:statsStart})," 至 ",tag("time",statsEnd,{datetime:statsEnd}));
    }
    article.append(riskMetricHeading(id,label,"h3"),metricResult(id,metric.value,format),note);
    return article;
  }));
  const riskMetrics = [
    ["annualReturn","年化收益率",pct],["drawdown","最大回撤",pct],["volatility","年化波动率",pct],
    ["sharpe","夏普比率",decimal],["sortino","索提诺比率",decimal],["calmar","卡玛比率",decimal],
    ["drawdownDays","最大回撤峰至谷",String],["recoveryDays","谷底至恢复峰值",String],
  ];
  $("risk-metrics").replaceChildren(...riskMetrics.map(([id,label,format])=>{
    const value = analysis.metrics[id];
    const item = tag("div",null,{class:"risk-metric"});
    item.append(riskMetricHeading(id,label,"span"),metricResult(id,value.value,format),
      tag("small",value.reason ?? (id.endsWith("Days") ? "自然日" : "")));
    return item;
  }));
  $("risk-assumptions").textContent = `风险指标使用分红再投资日收益，按 ${riskSessions} 个交易日年化。`;
  $("returns-source").hidden = !fund;
  $("returns-source").textContent = fund ? `基金净值来源 ${fund.source.name} · 最新确认 ${latest}` : "";
  charts.display("fund",analysis.points.fund);
  charts.display("drawdown",analysis.points.drawdown);
}
function renderNav(fund,start,end) {
  const adjusted=navMode==="adjusted";
  $("nav-adjusted").setAttribute("aria-pressed",String(adjusted));
  $("nav-raw").setAttribute("aria-pressed",String(!adjusted));
  $("nav-gaps").hidden=true;
  $("nav-gap-list").replaceChildren();
  try {
    const {gaps,anchors}=navChart.display(fund,navMode,start,end);
    const provenance=fund ? ` · 最新确认 ${fund.rows.at(-1).date} · ${fund.source.name}` : "";
    const basis=adjusted
      ? (anchors.length ? `分段复权，每段以 ${anchors[0]}${anchors.length>1?` 等 ${anchors.length} 个锚点`:""}的单位净值为起点，按总回报指数比例换算。`
        : "所选区间暂无可核验的复权净值。")
      : "基金确认的原始单位净值。";
    $("nav-basis").textContent=basis+(fund?" 净值按每份显示。":"")+provenance;
    $("nav-gaps").hidden=!adjusted||!gaps.length;
    if (!$("nav-gaps").hidden) {
      $("nav-gaps").querySelector("summary").textContent=`${gaps.length} 个复权净值缺口`;
      $("nav-gap-list").replaceChildren(...gaps.map(({date,reason})=>tag("li",`${date} · ${reason}`)));
    }
  } catch (error) {
    navChart.clear();
    $("nav-basis").textContent=error.message;
  }
}
function syncButtons() {
  for (const b of $("fund-periods").children) b.setAttribute("aria-pressed",String(b.dataset.period===rangeKey));
  $("fund-range").hidden = rangeKey!=="custom";
}
function navigateLink(event) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button!==0) return;
  event.preventDefault();
  history.pushState(null,"",event.currentTarget.href);
  void route();
}
async function route({scrollToTop=true}={}) {
  const version = ++routeNumber;
  const params = new URL(location.href).searchParams;
  const code = params.get("fund");
  const pinned=params.get("snapshot_id");
  selectedCode = FUND_CODE.test(code ?? "") ? code : null;
  $("fund-list").hidden = Boolean(selectedCode);
  $("fund-detail").hidden = !selectedCode;
  status("detail-import-status","");
  showValuation(null);
  navChart.clear();
  navMode="adjusted";
  if (!selectedCode) {
    if (code) status("list-status","基金详情需要六位场外基金代码。",true);
    renderList();
    return;
  }
  const current = selectedCode;
  const shared=sharedSnapshots.get(current);
  if ((pinned && pinned!==shared?.snapshot_id) || (shared && Date.parse(shared.expires_at)<=Date.now())) {
    sharedSnapshots.delete(current);
    loaded.delete(current);
  }
  rangeKey = "1y";
  historyLimit = 60;
  syncButtons();
  renderIdentity(current,loaded.get(current));
  renderAnalysis();
  status("detail-status",loaded.has(current) ? "" : noData);
  if (scrollToTop) window.scrollTo(0,0);
  if (loaded.has(current) && (local || online)) showValuation(current);
  if ((local || online) && !loaded.has(current)) {
    status("detail-status",`正在载入 ${current} 的确认净值…`);
    try {
      const fund = await loadFund(current,pinned);
      if (version!==routeNumber) return;
      if (online) addFund(catalog.get(current));
      status("detail-status","");
      syncButtons();
      renderIdentity(current,fund);
      renderAnalysis();
      showValuation(current);
    } catch (error) {if (version===routeNumber) status("detail-status",error.message,true);}
  }
}

async function importFiles(event) {
  const mode = event.currentTarget.id==="detail-import" ? "detail-import-status" : "list-status";
  const files = [...event.currentTarget.files];
  event.currentTarget.value = "";
  const loadedNames = [];
  const failures = [];
  for (const file of files) {
    try {
      if (file.size>BUNDLE_BYTES) throw new Error("图表包超出 16 MB。");
      const raw = JSON.parse(await file.text());
      if (raw.kind!=="fund_chart_bundle" && file.size>MAX_FILE_BYTES) throw new Error("净值文件超出 4 MB。");
      const {fund:dataset}=normalizeChartFile(raw);
      if (mode==="detail-import-status" && dataset.code!==selectedCode) throw new Error("文件基金代码与当前详情不一致。");
      sharedSnapshots.delete(dataset.code);
      snapshotFallback.delete(dataset.code);
      recordFund(dataset);
      addFund(catalog.get(dataset.code));
      loadedNames.push(dataset.code);
    } catch (error) {failures.push(`${file.name} · ${error.message}`);}
  }
  save();
  if (loadedNames.length && selectedCode) await route({scrollToTop:false});
  else renderList();
  status(mode,[loadedNames.length ? "已载入 " + loadedNames.join("、") + "。" : "",...failures].join(" "),Boolean(failures.length));
}

for (const [id,label] of Object.entries(FUND_CATEGORIES)) $("type-filter").append(tag("option",label,{value:id}));
$("type-filter").value=state.type;
$("type-filter").addEventListener("change",()=>{state.type=$("type-filter").value;save();renderList();});
$("show-all").addEventListener("click",()=>{state.favorites=false;save();renderList();});
$("show-favorites").addEventListener("click",()=>{state.favorites=true;save();renderList();});
for (const [id,label] of optionalColumns) {
  const check = tag("input",null,{type:"checkbox"});
  check.checked=!state.hidden.includes(id);
  check.addEventListener("change",()=>{
    state.hidden=check.checked ? state.hidden.filter((value)=>value!==id) : [...state.hidden,id];
    if (!check.checked && state.sort===id) {state.sort="name";state.descending=false;}
    save();renderList();
  });
  const option = tag("label");
  option.append(check,label);
  $("column-options").append(option);
}
$("fund-search").addEventListener("submit",async (event)=>{
  event.preventDefault();
  const number = ++searchNumber;
  const term = $("search-term").value.trim();
  if (online && FUND_CODE.test(term)) {
    history.pushState(null,"",url(term));
    await route();
    return;
  }
  let results = searchCatalog(catalog,term);
  if (term && (local || (online && !results.length))) {
    status("list-status","正在查找基金目录…");
    try {
      const entries = local?(await readApi("/search?q=" + encodeURIComponent(term))).funds:
        (await fetchFundDirectory()).values();
      if (number!==searchNumber) return;
      for (const entry of entries) catalog.set(entry.code,entry);
      results=searchCatalog(catalog,term);
      status("list-status","");
    } catch (error) {if (number===searchNumber) status("list-status",error.message,true);}
  }
  if (number!==searchNumber) return;
  if (!results.length && FUND_CODE.test(term)) results=[{code:term,name:null,category:"unknown"}];
  renderSearch(results,term);
});
$("list-import").addEventListener("change",importFiles);
$("detail-import").addEventListener("change",importFiles);
$("back-to-funds").addEventListener("click",navigateLink);
window.addEventListener("popstate",()=>void route());
$("valuation-refresh").addEventListener("click",valuation.refresh);
$("nav-adjusted").addEventListener("click",()=>{navMode="adjusted";renderNav(loaded.get(selectedCode),...navRange);});
$("nav-raw").addEventListener("click",()=>{navMode="raw";renderNav(loaded.get(selectedCode),...navRange);});
for (const [id,label] of detailPeriods) {
  const button = tag("button",label,{type:"button","data-period":id});
  button.addEventListener("click",()=>{rangeKey=id;syncButtons();if(id!=="custom") renderAnalysis();});
  $("fund-periods").append(button);
}
$("fund-range").addEventListener("submit",(event)=>{
  event.preventDefault();
  renderAnalysis($("fund-start").value,$("fund-end").value);
});
$("show-more-history").addEventListener("click",()=>{historyLimit+=60;historyTable(loaded.get(selectedCode));});

if (loopback && !online) {
  try {local=(await readApi("/status")).local===true;}
  catch {local=false;}
}
$("data-mode").textContent = online ? "输入六位基金代码直接查询。名称可搜索并添加至列表。" :
  local ? "本地模式可自动加载基金净值，也可导入数据包。" : "静态页面支持导入净值 JSON 或基金图表包。";
await route();
