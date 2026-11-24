// Uses the same calendar, stock adapters and ranking rules as the research tools.
import { calculateIndicators, resolveSymbol, rollingMean, validDate } from "../engine.mjs";
import { fetchHistory } from "../providers.mjs";
import { AVERAGES } from "./chart-data.mjs";
import { alignSectorReturns, rankAssociations } from "./sector-model.mjs";
import { readFundText, readPageData } from "./providers.mjs";

const HISTORY_START="2021-01-04";
const CSI_URL="https://www.csindex.com.cn/csindex-home/perf/index-perf";
const names={eastmoney:["东方财富","https://quote.eastmoney.com/center/hszs.html"],
  tencent:["腾讯财经","https://gu.qq.com/"]};
const clock=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",dateStyle:"short",timeStyle:"short"});
const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));

export function tradingWindow(calendar, now=new Date()) {
  const [today,time]=clock.format(now).split(" ");
  if (calendar?.schema_version!==1 || calendar.start>HISTORY_START || today>calendar.end ||
      !Array.isArray(calendar.sessions)) throw new Error("页面交易日历已超出覆盖范围。");
  const sessions=calendar.sessions.filter((day)=>day>=HISTORY_START&&day<=today);
  const end=sessions.findLast((day)=>day<today || time>="15:00");
  if (!end) throw new Error("交易日历缺少已收盘日期。");
  return {today,sessions,end};
}

export function publishedHoldings(code,{reports=[],classifications={}}={},catalog,asOf) {
  const eligible=reports.filter((r)=>r.share_codes.includes(code)&&r.disclosed_on<asOf)
    .sort((a,b)=>b.period_end.localeCompare(a.period_end)||b.disclosed_on.localeCompare(a.disclosed_on));
  const report=eligible[0];
  const support={};
  if (!report) return {support};
  const top=report.top??[];
  if (validDate(report.period_end)>validDate(report.disclosed_on) ||
      new Set(top.map((row)=>row.symbol)).size!==top.length ||
      top.reduce((sum,row)=>sum+row.weight_pct_nav,0)>100) throw new Error("持仓证据记录无效。");
  const source=new URL(report.source);
  if (source.protocol!=="https:" || source.username || source.password) throw new Error("持仓证据来源无效。");
  for (const position of top) {
    if (!(position.weight_pct_nav>0 && position.weight_pct_nav<=100)) throw new Error("持仓占比无效。");
    const dated=(classifications[position.symbol]??[]).filter((item)=>item.effective_from<=report.period_end&&
      (!item.effective_to||report.period_end<=item.effective_to)&&item.published_on<asOf);
    if (dated.length>1) throw new Error("持仓分类时间重叠。");
    if (!dated.length) continue;
    for (const index of dated[0].indices) {
      if (!catalog[index]||catalog[index].role==="market") throw new Error("持仓证据的指数代码无效。");
      const item=support[index]??{known_weight_pct_nav:0,positions:[],scope:"verified_disclosed_positions",
        disclosed_on:report.disclosed_on,source:report.source};
      item.known_weight_pct_nav+=position.weight_pct_nav;
      item.positions.push({symbol:position.symbol,source:dated[0].source});
      support[index]=item;
    }
  }
  for (const item of Object.values(support)) item.supportible=item.known_weight_pct_nav>=5;
  return {support,period_end:report.period_end,source:report.source};
}

const price=(value)=> (typeof value==="number" || (typeof value==="string"&&value.trim())) &&
  Number.isFinite(Number(value)) && Number(value)>0 ? Number(value) : null;

function csiRows(records,item,sessions,end) {
  if (!Array.isArray(records)||!records.length||records.length>sessions.size) throw new Error("中证指数历史缺失。");
  const seen=new Set();
  return records.map((row)=>{
    const day=String(row.tradeDate??"");
    const date=validDate(day.replace(/^(\d{4})(\d{2})(\d{2})$/,"$1-$2-$3"));
    const close=price(row.close);
    if (String(row.indexCode)!==item.code||row.indexNameCnAll!==item.name||
        close===null||!sessions.has(date)||date>end||seen.has(date)) throw new Error("中证指数身份、日期或价格异常。");
    seen.add(date);
    const ohl=[price(row.open),price(row.high),price(row.low)];
    const [open,high,low]=ohl.every((v)=>v!==null)&&ohl[1]>=Math.max(close,ohl[0])&&ohl[2]<=Math.min(close,ohl[0])?
      ohl:[null,null,null];
    return {date,close,open,high,low};
  }).sort((a,b)=>a.date.localeCompare(b.date));
}

function snapshotIndex(snapshot,item,sessions,end) {
  const record=snapshot?.indices?.[item.code];
  if (!record) return null;
  if (snapshot.schema_version!==1||record.source?.name?.trim()===""||
      typeof record.source?.name!=="string"||!Number.isFinite(Date.parse(record.retrieved_at))||
      validDate(record.last)>end || !Array.isArray(record.rows)) throw new Error("静态指数的来源或日期无效。");
  const url=new URL(record.source.url);
  if (url.protocol!=="https:"||url.username||url.password) throw new Error("静态指数来源无效。");
  const rows=csiRows(record.rows.map((row)=>({...row,indexCode:item.code,indexNameCnAll:item.name,
    tradeDate:row.date?.replaceAll("-","")})),item,sessions,end);
  const expected=[...sessions].filter((date)=>date>=rows[0].date&&date<=rows.at(-1).date).length;
  if (record.code!==item.code||record.name!==item.name||record.basis!=="price"||record.currency!=="CNY"||
      record.first!==rows[0].date||record.last!==rows.at(-1).date||record.internal_gaps!==expected-rows.length) {
    throw new Error("静态指数身份、价格口径或完整性说明不匹配。");
  }
  return {rows,source:{name:record.source.name,url:url.href,retrieved_at:record.retrieved_at},volume:false,transport:"static"};
}

async function fetchSpecial(item,sessions,end,signal) {
  const url=new URL(CSI_URL);
  url.search=new URLSearchParams({indexCode:item.code,startDate:HISTORY_START.replaceAll("-",""),endDate:end.replaceAll("-","")});
  const data=JSON.parse(await readFundText(url,{signal}));
  return {rows:csiRows(data.data,item,sessions,end),
    source:{name:"中证指数有限公司",url:item.definition,api_url:url.href},volume:false,transport:"browser-cors"};
}

function shapeRows(history,sessions) {
  const input=new Map(history.rows.map((row)=>[row.date,row]));
  const chunks=[];
  let block=[];
  const fields=[...AVERAGES,...(history.volume?["VOL5","VOL10"]:[])];
  const flush=()=>{
    if (!block.length) return;
    if (history.volume) chunks.push(...calculateIndicators(block).map((row)=>({...row,volume:row.volume_lots})));
    else {
      const ma=Object.fromEntries(AVERAGES.map((key)=>[key,rollingMean(block.map((row)=>row.close),Number(key.slice(2)))]));
      chunks.push(...block.map((row,i)=>({...row,...Object.fromEntries(AVERAGES.map((key)=>[key,ma[key][i]]))})));
    }
    block=[];
  };
  for (const date of sessions) {
    const row=input.get(date);
    if (row) block.push(row);
    else {
      flush();
      chunks.push({date,...Object.fromEntries(["open","high","low","close","volume",...fields].map((field)=>[field,null]))});
    }
  }
  flush();
  return chunks;
}

export function indexChartPayload(code,entry,analysis,history,sessions) {
  const first=history.rows[0].date,last=history.rows.at(-1).date;
  const inner=sessions.filter((day)=>day>=first&&day<=last);
  const internalGaps=inner.length-history.rows.length;
  return {schema_version:1,kind:"fund_sector_history",fund_code:code,code:entry.code,name:entry.name,
    model_as_of:analysis.model_as_of,model_index_as_of:entry.index_as_of,first,last,basis:"price",currency:"CNY",
    source:history.source,transport:history.transport,volume_unit:history.volume?"手":null,
    quality:{count:history.rows.length,internal_gaps:internalGaps,
      ohlc_rows:history.rows.filter((row)=>row.open!==null).length,volume_status:history.volume?"available":"missing"},
    rows:shapeRows(history,inner)};
}

export function sectorAnalysisPayload(fund,histories,config,bounds,computed=new Date().toISOString()) {
  const base={schema_version:1,kind:"fund_sector_analysis",fund_code:fund.code,fund_as_of:fund.rows.at(-1).date,
    computed_at:computed,history_start:HISTORY_START,sectors:[]};
  if (!["stock","mixed"].includes(fund.category) || fund.valuation_frequency!=="daily") {
    return {...base,status:"unsupported_fund"};
  }
  if (!Object.keys(histories).length) return {...base,status:"indices_unavailable"};
  const {indices,holdings}=config,{today,sessions}=bounds;
  const recent=new Set(sessions.slice(-150));
  const markets=[],candidates=[],prices={};
  for (const item of Object.values(indices)) {
    const history=histories[item.code];
    if (!history) continue;
    const rows=history.rows.filter((row)=>row.date>=(item.known_live_from??HISTORY_START));
    prices[item.code]=rows;
    if (rows.filter((row)=>recent.has(row.date)).length>=120) {
      (item.role==="market"?markets:candidates).push(item.code);
    }
  }
  const evidence=publishedHoldings(fund.code,holdings,indices,today);
  const result=rankAssociations(alignSectorReturns(fund,prices,sessions),candidates,markets,evidence.support);
  const used=new Set([...markets,...candidates]);
  return {...base,status:result.status,model_as_of:result.as_of??null,markets,candidate_count:candidates.length,
    index_coverage:{available:used.size,total:Object.keys(indices).length,
      missing:Object.keys(indices).filter((index)=>!used.has(index)),price_source:"股票行情引擎 / 中证"},
    model_age_sessions:sessions.filter((day)=>day>result.as_of).length,
    sectors:result.ranked.map((item,i)=>({code:item.code,name:indices[item.code].name,rank:i+1,quality:item.quality,
      beta:item.beta,stability:item.positive_fraction,windows:item.windows,index_as_of:histories[item.code].rows.at(-1).date,
      holdings:{status:item.holdings_evidence?"direct_support":"unverified",period_end:evidence.period_end??null,
        source:evidence.source??null,weight_pct_nav:item.holdings_evidence?.known_weight_pct_nav??null}}))};
}

export function createBrowserSectorProvider(configPromise, stockHistory=fetchHistory) {
  let cached;
  async function collect(config,calendar,bounds) {
    const histories={};
    const sessionSet=new Set(bounds.sessions);
    const snapshot=config.index_snapshot?await readPageData(config.index_snapshot).catch(()=>null):null;
    const items=Object.values(config.indices);
    const special=items.filter((item)=>{
      try {resolveSymbol(item.code,"index");return false;}
      catch {return true;}
    });
    const missingSpecial=new Set(special.map((item)=>item.code));
    const deadline=AbortSignal.timeout(45_000);
    const getJSON=async(url)=>JSON.parse(await readFundText(url,{signal:deadline}));
    const collectSpecial=async()=>{
      let direct=true;
      for (const item of special) {
        if (deadline.aborted) break;
        try {
          const data=snapshotIndex(snapshot,item,sessionSet,bounds.end)??(direct?
            await fetchSpecial(item,sessionSet,bounds.end,deadline):null);
          if (data) histories[item.code]=data;
        } catch (error) {
          if (error instanceof TypeError || /HTTP (401|403|429)/.test(error.message)) direct=false;
        }
        if (direct) await delay(250);
      }
    };
    const queue=items.filter((item)=>!missingSpecial.has(item.code));
    const collectStock=async()=>{
      while (queue.length&&!deadline.aborted) {
        const item=queue.shift();
        try {
          const result=await stockHistory({symbol:item.code,kind:"index",start:HISTORY_START,end:bounds.end},calendar,getJSON);
          const [name,url]=names[result.source];
          histories[item.code]={rows:result.rows,source:{name,url,id:result.source},volume:true,transport:"browser-cors"};
        } catch { /* Missing candidates remain visible in coverage and are not substituted. */ }
        await delay(150);
      }
    };
    await Promise.all([collectStock(),collectStock(),collectStock(),collectSpecial()]);
    return histories;
  }
  async function base() {
    const [config,calendar]=await Promise.all([configPromise(),readPageData("calendar.json")]);
    const bounds=tradingWindow(calendar);
    const now=Date.now();
    if (!cached || cached.end!==bounds.end || now-cached.time>5*60_000) {
      const pending=collect(config,calendar,bounds);
      cached={end:bounds.end,time:now,pending};
      pending.then((items)=>{if (!Object.keys(items).length&&cached?.pending===pending) cached=null;},
        ()=>{if (cached?.pending===pending) cached=null;});
    }
    return {config,bounds,histories:await cached.pending};
  }
  return {
    async analyze(fund) {
      if (!["stock","mixed"].includes(fund.category)||fund.valuation_frequency!=="daily") {
        return {report:sectorAnalysisPayload(fund,{},{},{})};
      }
      const {config,bounds,histories}=await base();
      return {report:sectorAnalysisPayload(fund,histories,config,bounds),histories,sessions:bounds.sessions};
    },
    history(fundCode,entry,context) {
      return indexChartPayload(fundCode,entry,context.report,context.histories[entry.code],context.sessions);
    },
  };
}
