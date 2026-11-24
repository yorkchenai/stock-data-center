import { FIELDS, resolveSymbol, validDate } from "../../web/engine.mjs";
import { fetchHistory } from "../../web/providers.mjs";
import { FUND_CODE, fundFreshness, normalizeFund } from "../../web/funds/data.mjs";
import {
  assignment, fundFromAssignments, parseDirectory, readNavAssignments,
} from "../../web/funds/nav-source.mjs";
import { navURL } from "../../web/funds/providers.mjs";
import { PERIODS, analyzePerformance, periodReturn, periodStart, selectWindow } from "../../web/funds/performance.mjs";
import { createBrowserSectorProvider } from "../../web/funds/sector-browser.mjs";
import { marketTransport } from "./providers.mjs";

export const STOCK_START = "2025-01-01";

export function currentMarketWindow(calendar, now) {
  const shanghai = new Date(now.getTime()+8*3_600_000).toISOString();
  const today = shanghai.slice(0,10);
  if (today>calendar.end) throw new Error("交易日历尚未覆盖今天。");
  const completeToday=shanghai.slice(11,13)>="17";
  const end=calendar.sessions.findLast((date)=>date<today || date===today && completeToday);
  const next=calendar.sessions.find((date)=>date>end);
  if (!end) throw new Error("交易日历没有已完成的交易日。");
  return {today,end,next};
}

export function analysisQuery(args, calendar, now = new Date()) {
  if (!args || !["stock","fund"].includes(args.asset_type) ||
      typeof args.symbol!=="string" || args.symbol.length>12) throw new Error("请选择标的类型和有效代码。");
  if (args.asset_type==="fund") {
    if (!FUND_CODE.test(args.symbol) || args.start || args.end || args.kind) throw new Error("请输入六位基金代码。");
    return {asset_type:"fund",symbol:args.symbol};
  }
  const instrument=resolveSymbol(args.symbol,args.kind??"auto");
  const market=currentMarketWindow(calendar,now);
  const start=validDate(args.start??STOCK_START), end=validDate(args.end??market.end);
  if (start<calendar.start || start>end || end>market.today) throw new Error("股票日期超出有效查询区间。");
  const queryEnd=calendar.sessions.findLast((day)=>day<=end && day<=market.end);
  if (!queryEnd || start>queryEnd) throw new Error("查询区间内没有已完成交易日。");
  return {asset_type:"stock",symbol:instrument.market+instrument.code,kind:instrument.kind,start,end:queryEnd};
}

export function snapshotExpiry(query, data, calendar, now) {
  const ms=now.getTime();
  if (query.asset_type==="fund") return ms+(data.status==="complete"?30:10)*60_000;
  if (data.status==="partial") return ms+10*60_000;
  const market=currentMarketWindow(calendar,now);
  if (query.end<market.end) return ms+86_400_000;
  return Math.min(ms+4*3_600_000,market.next?Date.parse(market.next+"T09:00:00Z"):Infinity);
}

function fundPerformance(fund) {
  const end=fund.rows.at(-1).date;
  const returns=Object.fromEntries(PERIODS.map(([key])=>[key,periodReturn(fund,key)]));
  const windows=Object.fromEntries([...PERIODS.map(([key])=>key),"all"].map((key)=>{
    const window=selectWindow(fund,key==="all"?null:periodStart(end,key),end);
    return [key,{start:window.start??null,end:window.end??null,...analyzePerformance(fund,window)}];
  }));
  return {returns,windows,currency:"CNY",observations_per_year:252,sortino_target:0,
    risk_free:fund.risk_free,return_basis:fund.return_basis};
}

export function createSnapshotCompute({calendar,config,fetcher=fetch,observe,clock=()=>new Date()}) {
  let directory;
  const getDirectory=async(text)=>{
    if (directory && directory.expires > clock().getTime()) return directory.catalog;
    const catalog=parseDirectory(assignment(await text("https://fund.eastmoney.com/js/fundcode_search.js"),"r"));
    directory={expires:clock().getTime()+86_400_000,catalog};
    return catalog;
  };
  const sectors=createBrowserSectorProvider(async()=>config,fetchHistory,async(file)=>{
    if (file==="calendar.json") return calendar;
    throw new Error("没有配置特殊指数快照。");
  },{timeout:23_000,priorityMarkets:true,reusePending:false,stockTransport:"worker-https"});

  return async function compute(query,{refresh=false,onUpstream=observe}={}) {
    const text=marketTransport(fetcher,onUpstream);
    if (query.asset_type==="stock") {
      const deadline=AbortSignal.timeout(18_000);
      const getJSON=async(url)=>JSON.parse(await text(url,{signal:deadline,timeout:4_500}));
      const dataset=await fetchHistory(query,calendar,getJSON,{preferComplete:true});
      const {rows,validation,...meta}=dataset;
      if (validation.suspension_data_conflicts.length) throw new Error("行情与确认停牌记录冲突。");
      const last=rows.at(-1);
      const stale=validation.unverified_missing_sessions.some((date)=>date>last.date);
      const status=validation.unverified_missing_sessions.length?"partial":"complete";
      return {status,source:{name:meta.source,retrieved_at:meta.fetched_at_utc,attempts:meta.attempts},
        data_as_of:last.date,quality:{...validation,stale},raw_data:{
          history:rows.map((row)=>Object.fromEntries(FIELDS.map((field)=>[field,row[field]]))),
          stock:{...meta,transport:"worker-https",validation},
        },indicators:{rows},
        models:{technical_analysis:{status:"complete",calculation_start:query.start}},
        summary:{instrument:meta.instrument,instrument_name:meta.instrument_name,latest:last,last_trade_date:last.date,
          expected_session:query.end,stale,units:meta.units}};
    }

    const url=navURL(query.symbol);
    const [assignments,catalog]=await Promise.all([text(url),getDirectory(text).catch(()=>null)]);
    const raw=fundFromAssignments(readNavAssignments(assignments),query.symbol,{
      metadata:catalog?.get(query.symbol),evidence:config.events?.[query.symbol],benchmark:config.benchmarks?.[query.symbol],
      retrievedAt:clock(),
    });
    raw.source={...raw.source,api_url:url,transport:"worker-https"};
    const fund=normalizeFund(raw);
    const risk=fundPerformance(fund);
    const last=fund.rows.at(-1);
    let association, charts={}, indexInputs={};
    try {
      const context=await sectors.analyze(fund,{refresh,readText:text});
      association=context.report;
      // Keep the exact inputs supplied to the ranking engine without storing
      // another copy of all stock-indicator columns not used by that model.
      indexInputs=Object.fromEntries(Object.entries(context.histories??{}).map(([code,history])=>[code,{
        source:history.source,transport:history.transport,volume:history.volume,
        rows:history.rows.map(({date,open,high,low,close,volume_lots,turnover_cny})=>
          ({date,open,high,low,close,volume_lots,turnover_cny})),
      }]));
      for (const item of association.sectors) {
        charts[item.code]=sectors.history(fund.code,item,context);
      }
    } catch {
      association=null;
    }
    const return_gaps=fund.rows.filter((row)=>row.return_index==null)
      .map(({date,return_issue})=>({date,reason:return_issue}));
    const freshness=fundFreshness(fund);
    const index_coverage=association?.index_coverage??null;
    const status=return_gaps.length || !freshness.startsWith("已确认披露") ||
      !["ok","unsupported_fund","no_reliable_association"].includes(association?.status) ||
      (index_coverage && index_coverage.available<index_coverage.total) ||
      risk.windows["1y"].metrics.sharpe.value===null ? "partial" : "complete";
    return {status,source:raw.source,data_as_of:last.date,
      quality:{freshness,return_gaps,index_coverage,sector_status:association?.status??"indices_unavailable",
        benchmark_status:risk.windows["1y"].comparison?.status??"unavailable",
        risk_free_available:Boolean(fund.risk_free)},
      raw_data:{history:raw.rows,fund:{...raw,rows:undefined},sector_index_history:indexInputs},
      indicators:{},
      models:{risk,sectors:{report:association,charts}},
      summary:{name:fund.name,category:fund.category,last_confirmed_nav_date:last.date,latest_nav:last.unit_nav,
        returns:Object.fromEntries(["1m","3m","1y"].map((key)=>[key,risk.returns[key]])),
        max_drawdown:risk.windows["1y"].metrics.drawdown,index_coverage,
        sector_status:association?.status??"indices_unavailable",
        sectors:(association?.sectors??[]).map(({code,name,beta,stability,index_as_of})=>
          ({code,name,beta,stability,last_index_trade_date:index_as_of}))}};
  };
}
