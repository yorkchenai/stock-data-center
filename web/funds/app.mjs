import { FUND_CATEGORIES, FUND_CODE, MAX_FILE_BYTES, fundFreshness, normalizeFund, searchCatalog, shanghaiToday } from "./data.mjs";
import { PERIODS, analyzePerformance, periodReturn, periodStart, selectWindow } from "./performance.mjs";
import { createFundCharts } from "./charts.mjs";
import { BUNDLE_BYTES, normalizeChartFile } from "./chart-data.mjs";
import { createNavChart } from "./nav-chart.mjs";
import { fetchFund, fetchFundDirectory, readPageData } from "./providers.mjs";
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
const pp = (v) => (100 * v).toFixed(2) + " 个百分点";
const decimal = (v) => v.toFixed(2);
const nav = (v) => v.toFixed(4);
const shown = (v, format) => v == null ? "—" : format(v);
const describe = (v) => FUND_CATEGORIES[v] ?? FUND_CATEGORIES.unknown;
const key = "stock-data-center.off-market-funds.v1";
const loaded = new Map();
const catalog = new Map();
const beingLoaded = new Map();
const sharedSnapshots = new Map();
const snapshotFallback = new Map();
const columns = [
  ["name","基金名称 / 代码"],["type","基金类型"],["nav","最新单位净值"],["date","净值日期"],...PERIODS,
  ["source","来源"],["actions","操作"],
];
const optionalColumns = columns.filter(([id])=>!["name","actions"].includes(id));
const detailPeriods = [...PERIODS.slice(1),["all","全部历史"],["custom","自定义"]];
const coreDefinitions = [
  ["return","区间收益率",pct,"区间末总回报指数相对起点的变化。"],
  ["drawdown","最大回撤",pct,"区间内总回报指数从峰值到谷底的最大跌幅。"],
  ["sharpe","夏普比率",decimal,"以有出处的年化无风险利率换算日利率。"],
  ["volatility","年化波动率",pct,"日收益样本标准差按 252 日年化。"],
  ["sortino","索提诺比率",decimal,"年化目标收益 0%，下行偏差包含全部日收益样本。"],
  ["excess","超额收益",pp,"基金区间收益减去同起止日的官方比较基准收益。"],
];
const charts = createFundCharts();
const navChart = createNavChart($("nav-chart"),$("nav-hover"));
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
    const pending=online?loadOnlineFund(code,snapshotId):readApi("/" + code).then((raw)=>({raw}));
    const disclosures = online ? fetchPageDisclosures() : null;
    beingLoaded.set(key,Promise.all([pending,disclosures]).then(([{raw,snapshot},reviewed])=>{
      const fund = normalizeFund(raw);
      if (fund.code !== code) throw new Error("查询结果的基金代码不一致。");
      const display = reviewed?.[code];
      if (display && display.effective_from <= fund.rows.at(-1).date &&
          (!fund.benchmark_disclosure || display.effective_from >= fund.benchmark_disclosure.effective_from)) {
        fund.benchmark_disclosure = display;
      }
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
  try {await loadFund(code);status("list-status",`已载入 ${code}。`);}
  catch (error) {status("list-status",error.message,true);}
  renderList();
}
function tableValue(id, row, fund) {
  if (id==="name") return {value:row.name};
  if (id==="type") return {value:describe(row.category)};
  if (!fund) return {value:null,reason:"本会话尚未载入净值。"};
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
    const th = tag("th",null,{scope:"col"});
    if (id==="actions") th.textContent = label;
    else {
      if (sorted) th.setAttribute("aria-sort",state.descending ? "descending" : "ascending");
      const button = tag("button",label + (sorted ? state.descending ? " ↓" : " ↑" : ""),{type:"button"});
      button.addEventListener("click",()=>{
        state.descending = state.sort===id ? !state.descending : PERIODS.some(([period])=>period===id);
        state.sort = id;
        save();
        renderList();
      });
      th.append(button);
    }
    header.append(th);
  }
  $("fund-table").tHead.replaceChildren(header);
  const items = state.list.filter((entry)=>(!state.favorites || entry.favorite) && (!state.type || state.type===entry.category))
    .map((row)=>{
      const fund = loaded.get(row.code);
      const entries = Object.fromEntries(active.filter(([id])=>id!=="actions").map(([id])=>[id,tableValue(id,row,fund)]));
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
  if (!items.length) {
    const message = state.list.length ? "当前筛选下没有基金。" : "搜索并添加基金，或导入确认净值 JSON。";
    target.replaceChildren(tag("tr"));
    target.firstChild.append(tag("td",message,{colspan:active.length,class:"empty-cell"}));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const {row,entries,fund} of items) {
    const tr = tag("tr");
    for (const [id] of active) {
      const td = tag("td");
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
          refresh.addEventListener("click",()=>{refresh.disabled=true;void loadListFund(row.code);});
          td.append(" ",refresh);
        }
      } else {
        const {value,format,reason,percent} = entries[id];
        td.textContent = shown(value,format ?? String) + (id==="date" && fund?.mode==="synthetic" ? " · 测试" : "");
        if (reason) {td.title=reason;td.className="fund-missing";}
        else if (percent && value) td.className = value>0 ? "fund-positive" : "fund-negative";
      }
      tr.append(td);
    }
    fragment.append(tr);
  }
  target.replaceChildren(fragment);
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
function renderBenchmark(fund, asOf) {
  const benchmark = fund?.benchmark;
  const disclosure = fund?.benchmark_disclosure;
  const regime = benchmark?.regimes.find(({effective_from,effective_to})=>
    effective_from <= asOf && (!effective_to || asOf <= effective_to));
  const formula = disclosure?.formula ?? regime?.formula ?? benchmark?.formula;
  const description = formula && /\d\s*[%％]/.test(formula) ? formula : benchmark?.name ?? formula;
  $("benchmark-disclosure").textContent = description
    ? description.replace(/\s*[＋+]\s*/g," + ").replace(/\s*×\s*/g," × ")
    : "业绩比较基准暂未核实";

  const source = $("benchmark-source");
  const since = disclosure?.effective_from ?? regime?.effective_from ?? benchmark?.effective_from;
  const url = disclosure?.source_url ?? regime?.source_url ?? benchmark?.source_url;
  source.replaceChildren();
  if (description && since) source.append("生效日期 ",tag("time",since,{datetime:since}));
  if (description && typeof url === "string" && URL.canParse(url)) {
    const link = new URL(url);
    if (link.protocol === "https:" && !link.username && !link.password) {
      if (source.hasChildNodes()) source.append(" · ");
      source.append(tag("a","查看官方披露",{href:link.href,target:"_blank",rel:"noopener noreferrer"}));
    }
  }
  source.hidden = !source.hasChildNodes();

  const tracking = $("tracking-index");
  const target = disclosure?.tracking_index ?? fund?.related.find(({kind})=>kind==="official_tracking");
  tracking.hidden = !target?.name;
  tracking.textContent = target?.name ? "跟踪指数 · " + target.name : "";
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
  renderBenchmark(fund,latest?.date);
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
    const article = tag("article",null,{class:"metric","data-metric":id,title:description});
    const metric = analysis.metrics[id];
    const note = tag("small",metric.reason ?? interval);
    if (!metric.reason && statsStart) {
      note.replaceChildren(tag("time",statsStart,{datetime:statsStart})," 至 ",tag("time",statsEnd,{datetime:statsEnd}));
    }
    article.append(tag("h3",label),tag("strong",shown(metric.value,format)),note);
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
    item.append(tag("span",label),tag("strong",shown(value.value,format)),tag("small",value.reason ?? (id.endsWith("Days") ? "自然日" : "")));
    return item;
  }));
  const risk = fund?.risk_free;
  const convention = {simple_act_365f:"单利 ACT/365F",effective_act_365f:"复利 ACT/365F",simple_act_360:"单利 ACT/360"};
  const riskLabel = risk?.rows
    ? `${risk.name} · ${convention[risk.convention]} · ${risk.effective_from} 至 ${risk.effective_to} · ${risk.source}`
    : risk ? `年利率 ${pct(risk.annual_rate)} · 复利按 252 日折算 · ${risk.source}` : "缺少有出处的无风险利率时不计算夏普";
  $("risk-assumptions").textContent = "日收益波动率与日超额收益夏普均按 252 个净值观察日年化。索提诺目标为 0%。" + riskLabel + "。";
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
async function route() {
  const version = ++routeNumber;
  const params = new URL(location.href).searchParams;
  const code = params.get("fund");
  const pinned=params.get("snapshot_id");
  selectedCode = FUND_CODE.test(code ?? "") ? code : null;
  $("fund-list").hidden = Boolean(selectedCode);
  $("fund-detail").hidden = !selectedCode;
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
  window.scrollTo(0,0);
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
    } catch (error) {if (version===routeNumber) status("detail-status",error.message,true);}
  }
}

async function importFiles(event) {
  const mode = event.currentTarget.id==="detail-import" ? "detail-status" : "list-status";
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
      if (mode==="detail-status" && dataset.code!==selectedCode) throw new Error("文件基金代码与当前详情不一致。");
      sharedSnapshots.delete(dataset.code);
      snapshotFallback.delete(dataset.code);
      recordFund(dataset);
      addFund(catalog.get(dataset.code));
      loadedNames.push(dataset.code);
    } catch (error) {failures.push(`${file.name} · ${error.message}`);}
  }
  save();
  if (loadedNames.length && selectedCode) await route();
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
window.addEventListener("popstate",route);
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
