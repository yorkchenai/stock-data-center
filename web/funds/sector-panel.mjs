import { createSectorChart } from "./sector-chart.mjs";
import { dayAge, normalizeAssociations, normalizeIndex } from "./chart-data.mjs";
import { periodStart } from "./performance.mjs";

const $=(id)=>document.getElementById(id);
const STATUSES={
  unsupported_fund:"当前模型适用于具备日频总回报的主动股票型或混合型基金。",
  insufficient_coverage:"共同样本或候选指数不足，暂无可靠关联。",
  no_reliable_association:"当前统计窗口未识别出可靠关联板块。",
  indices_unavailable:"指数数据源暂不可访问。",
  fund_data_unavailable:"基金净值与模型要求的交易日历或总回报口径不匹配。",
};
const EVIDENCE={
  direct_support:"已披露持仓直接支持",
  unverified:"持仓尚未核实",
  conflict:"持仓资料存在冲突",
  insufficient:"持仓样本不足，无法可靠判断",
};
const stamp = (date)=>new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",dateStyle:"short",timeStyle:"short"}).format(new Date(date));

export function createSectorPanel() {
  const container=$("sector-chart");
  const graph=createSectorChart(container,$("sector-ohlc"),[$("sector-ma"),$("sector-vol")],
    $("sector-volume-note"),$("sector-history-note"));
  let request, indexRequest, generation=0, indexVersion=0, code, report, mode, onlineContext, bundle, current, history, period="1y";
  const histories=new Map();
  function text(id,value) { $(id).textContent=value; }
  function hide(id,hidden) { $(id).hidden=hidden; }
  function clearDetails() {
    graph.clear();
    delete container.dataset.chartMode;
    hide("sector-display",true);
    for (const id of ["sector-metrics","sector-index-title","sector-index-meta","sector-evidence","sector-range-status"]) text(id,"");
  }
  function clear() {
    generation++;
    indexVersion++;
    request?.abort();
    indexRequest?.abort();
    code=report=current=history=mode=onlineContext=null;
    histories.clear();
    graph.clear({reset:true});
    clearDetails();
    $("sector-tabs").replaceChildren();
    text("sector-status","");
    text("sector-analysis-meta","");
    hide("sector-refresh",true);
  }

  async function fetchLocal(action,signal,timeout) {
    const response=await fetch(new URL("/api/funds/"+action,location.origin),{
      cache:"no-store",signal:AbortSignal.any([signal,AbortSignal.timeout(timeout)]),
    });
    const data=await response.json();
    if (!response.ok) throw new Error(data.error??"关联接口暂不可用。");
    return data;
  }

  function setPeriod(next) {
    period=next;
    if (!history) return;
    for (const b of $("sector-periods").children) b.setAttribute("aria-pressed",String(b.dataset.period===next));
    hide("sector-range",next!=="custom");
    if (next!=="custom") displayRange(next==="all"?history.first:periodStart(history.last,next),history.last);
  }
  function displayRange(start,end) {
    if (start>end || start>history.last || end>history.last || end<history.first) {
      text("sector-range-status","所选日期超出已载入的指数历史。");
      return;
    }
    const rows=history.rows.filter((row)=>row.date>=start&&row.date<=end);
    graph.display(history,rows);
    text("sector-range-status",rows.length?`显示 ${rows[0].date} 至 ${rows.at(-1).date}`:"所选日期没有指数交易日。");
  }
  function newLink(label,href) {
    const a=document.createElement("a");
    a.target="_blank";
    a.rel="noopener noreferrer";
    a.href=href;
    a.textContent=label;
    return a;
  }
  function renderIndex(data) {
    history=data;
    text("sector-index-title",`${data.name} ${data.code}`);
    hide("sector-display",false);
    const about=$("sector-index-meta");
    about.replaceChildren(`指数行情 · 点 · ${history.first} 至 ${history.last} · `,
      newLink(history.source.name,history.source.url));
    if (history.model_index_as_of !== history.last) about.append(` · 关联模型指数数据截至 ${history.model_index_as_of}`);
    if (history.transport==="static") about.append(" · 静态历史");
    const gaps=history.quality?.internal_gaps;
    if (Number.isInteger(gaps) && gaps) about.append(` · 未补齐 ${gaps} 个开市缺口`);
    if (dayAge(history.last)>7) about.append(" · 行情日期已超过 7 天");
    for (const id of ["sector-from","sector-to"]) {
      $(id).min=history.first;
      $(id).max=history.last;
    }
    $("sector-from").value=history.first;
    $("sector-to").value=history.last;
    setPeriod(period==="custom"?"1y":period);
  }
  async function select(entry) {
    const id=++indexVersion;
    const context=generation;
    indexRequest?.abort();
    indexRequest=new AbortController();
    current=entry;
    history=null;
    clearDetails();
    const bars=$("sector-tabs");
    for (const tab of bars.children) tab.setAttribute("aria-pressed",String(tab.dataset.index===entry.code));
    const format=(val)=>val.toFixed(3);
    const short=entry.windows[60],long=entry.windows[120];
    text("sector-metrics",`第 ${entry.rank} 名 · ${entry.quality==="strong"?"强关联":"中等关联"} · Pearson 60/120 日 ${format(short.pearson)} / ${format(long.pearson)} · 市场偏相关 ${format(short.partial)} / ${format(long.partial)} · Ridge ${format(entry.beta)} · 稳定性 ${(entry.stability*100).toFixed(0)}%`);
    const h=entry.holdings;
    const direct=h.status==="direct_support";
    $("sector-evidence").replaceChildren(EVIDENCE[h.status] + (direct?` · 已映射仓位占净资产 ${h.weight_pct_nav.toFixed(2)}%`:"")
      + (h.period_end?` · 报告期 ${h.period_end}`:""));
    if (h.source) $("sector-evidence").append(" · ",newLink("持仓报告",h.source));
    text("sector-status",`正在载入 ${entry.name}…`);
    try {
      let confirmed=histories.get(entry.code)??bundle?.indexes.get(entry.code);
      if (!confirmed) {
        const raw=mode.snapshot ? await mode.loadSnapshotIndex(mode.snapshot,entry.code) :
          onlineContext?mode.browser.history(code,entry,onlineContext):
          await fetchLocal(`${code}/sectors/${entry.code}`,indexRequest.signal,300_000);
        if (id!==indexVersion||context!==generation) return;
        confirmed=normalizeIndex(raw,code,entry,report.model_as_of);
        histories.set(entry.code,confirmed);
      }
      if (id!==indexVersion||context!==generation) return;
      renderIndex(confirmed);
      text("sector-status","");
    } catch (error) {
      if (id===indexVersion&&context===generation) text("sector-status",error.message);
    }
  }
  async function start(nextCode,nextMode,refresh=false) {
    clear();
    const version=generation;
    code=nextCode;
    mode=nextMode;
    bundle=refresh?null:mode.bundle;
    const available=mode.local || Boolean(mode.snapshot || mode.browser && mode.fund?.mode==="reported");
    period="1y";
    hide("sector-refresh",!available || Boolean(mode.snapshot));
    $("sector-refresh").disabled=true;
    if (!code) return;
    if (!available&&!bundle) {
      text("sector-status","可导入包含关联指数历史的基金图表包。");
      return;
    }
    text("sector-status","正在识别关联板块并检查指数历史。首次加载可能需要几分钟。");
    request=new AbortController();
    try {
      if (!bundle && !mode.local && !mode.snapshot) {
        const result=await mode.browser.analyze(mode.fund);
        if (version!==generation) return;
        onlineContext=result;
      }
      if (mode.snapshot && !mode.snapshot.data.association) {
        text("sector-status",mode.snapshot.data.association_message??STATUSES.indices_unavailable);
        return;
      }
      const source=bundle?bundle.analysis:normalizeAssociations(mode.snapshot?.data.association ??
        onlineContext?.report??await fetchLocal(`${code}/sectors`,request.signal,300_000),nextCode);
      if (version!==generation) return;
      report=source;
      const timestamp=stamp(report.computed_at);
      const outdated=report.model_age_sessions>5 || dayAge(report.model_as_of)>7
        || Date.now()-Date.parse(report.computed_at)>7*86400000;
      const coverage=report.index_coverage;
      const coverageText=coverage?
        ` · 指数覆盖 ${coverage.available}/${coverage.total}${coverage.missing.length?` · 未纳入 ${coverage.missing.join("、")}`:""}`:"";
      text("sector-analysis-meta",`净值截至 ${report.fund_as_of} · 模型截至 ${report.model_as_of??"—"} · 计算时间 ${timestamp}（上海）${outdated?" · 数据可能已过期":""}${coverageText}`);
      if (!report.sectors.length) {
        text("sector-status",STATUSES[report.status]??"当前暂无可用关联分析。");
        return;
      }
      for (const entry of report.sectors) {
        const b=document.createElement("button");
        b.type="button";
        b.dataset.index=entry.code;
        b.textContent=`${entry.name} ${entry.code}`;
        b.addEventListener("click",()=>void select(entry));
        $("sector-tabs").append(b);
      }
      await select(report.sectors[0]);
    } catch (error) {
      if (version===generation) text("sector-status",error.message);
    } finally {
      if (version===generation) $("sector-refresh").disabled=false;
    }
  }
  $("sector-refresh").addEventListener("click",()=>{if(code&&mode) void start(code,mode,true);});
  for (const [key,label] of [["3m","近3月"],["6m","近6月"],["1y","近1年"],["3y","近3年"],["5y","近5年"],["all","全部历史"],["custom","自定义"]]) {
    const button=document.createElement("button");
    button.type="button";
    button.dataset.period=key;
    button.textContent=label;
    button.addEventListener("click",()=>setPeriod(key));
    $("sector-periods").append(button);
  }
  $("sector-range").addEventListener("submit",(event)=>{
    event.preventDefault();
    if (history) displayRange($("sector-from").value,$("sector-to").value);
  });
  return {start,clear};
}
