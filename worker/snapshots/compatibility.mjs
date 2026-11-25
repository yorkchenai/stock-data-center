import { analysisQuery, currentMarketWindow, STOCK_START } from "./compute.mjs";
import { snapshotMetadata, summarizeTradingWindow } from "./details.mjs";

const stockOrder=["价格定位置","均线判趋势","成交量看配合","MACD看动量变化","RSI看相对强弱"];
const ready=new Set(["complete","partial"]);
const previousDate=(date)=>new Date(Date.parse(date)-86_400_000).toISOString().slice(0,10);

export function prepareInitial(assetType,args,calendar,now) {
  if (assetType==="fund") return {args:{...args,asset_type:assetType},present:fundSummary};
  const market=currentMarketWindow(calendar,now);
  if (args.start && args.start<STOCK_START) throw new Error(`本工具的历史起点为 ${STOCK_START}。`);
  const session=analysisQuery({...args,asset_type:assetType},calendar,now).end;
  const historical=session<market.end;
  const {start,...params}=args;
  return {args:{...params,asset_type:assetType},present:(snapshot,cache)=>stockSummary(snapshot,cache,{
    start:start??null,end:args.end??market.today,session,historical,until:market.next ?
      `${market.next}T09:00:00.000Z` : new Date(Date.parse(calendar.end)+86_400_000).toISOString().slice(0,10)+"T00:00:00+08:00",
  })};
}

function stockSummary(snapshot,cache,window) {
  const metadata=snapshotMetadata(snapshot);
  const all=snapshot.indicators.rows;
  const eligible=window.start ? all.filter((row)=>row.date>=window.start) : all;
  const rows=eligible.slice(window.start?-120:-60);
  const more=Boolean(window.start && rows.length<eligible.length);
  const audit=snapshot.quality;
  const suspensions=audit.confirmed_suspension_sessions??[];
  const gaps=audit.unverified_missing_sessions??[];
  const recent=summarizeTradingWindow(rows,20);
  if (recent) recent.unverified_gap_count=gaps.filter((date)=>date>=recent.first&&date<=recent.last).length;
  const stale=Boolean(audit.stale);
  const status=!rows.length ? "no_daily_data" : stale ? "stale" : snapshot.status==="partial" ? "partial" :
    snapshot.data_as_of<window.session ? "suspended" : "ok";
  const name=snapshot.summary.instrument_name;
  return {...metadata,...snapshot.summary,cache,status,snapshot_status:snapshot.status,
    source:snapshot.source.name,instrument_name:typeof name==="string" && /^[\p{L}\p{M}\p{N} *·.()（）\-]{1,64}$/u.test(name)?name:null,
    requested_start:window.start,requested_end:window.end,
    calculation_start:snapshot.models.technical_analysis.calculation_start??STOCK_START,
    first_available_trade_date:all[0].date,last_trade_date:snapshot.data_as_of,expected_session:window.session,
    fetched_at_utc:snapshot.source.retrieved_at,freshness_until_utc:window.historical?null:window.until,
    stale,historical:window.historical,adjustment:"none",
    units:{price:snapshot.raw_data.stock.instrument.kind==="index"?"点":"元",volume_lots:"手",VOL5:"手",VOL10:"手",turnover_cny:"元",change_pct:"%"},
    quality:{calendar:audit.calendar,calendar_version:audit.calendar_version,expected_sessions:audit.expected_sessions,
      observed_sessions:audit.observed_sessions,confirmed_suspensions:suspensions.length,recent_confirmed_suspensions:suspensions.slice(-20),
      unverified_gaps:gaps.length,recent_unverified_gaps:gaps.slice(-20),completeness_verified:audit.completeness_verified},
    attempts:(snapshot.source.attempts??[]).map((item)=>({source:item.source,status:item.status==="success" ?
      (item.source===snapshot.source.name && ["stale","partial"].includes(status)?status:"ok") :
      (item.status==="failed"?"upstream_error":item.status)})),
    returned_rows:rows.length,more,next_end:more?previousDate(rows[0].date):null,
    recent_20_trading_days:recent,
    analysis_order:stockOrder,supplementary_indicator:"ADX14",rows,latest:rows.at(-1)??null};
}

function fundSummary(snapshot,cache) {
  const {summary,quality,models}=snapshot;
  const window=models.risk.windows["1y"];
  const report=models.sectors.report;
  return {...snapshotMetadata(snapshot),...summary,cache,status:snapshot.status==="complete"?"ok":"partial",
    snapshot_status:snapshot.status,freshness:quality.freshness,
    max_drawdown:{...summary.max_drawdown,start:window.start,end:window.end},
    sector_message:null,sector_model_as_of:report?.model_as_of??null,
    sectors:summary.sectors.map((item)=>({...item,rank:report?.sectors.find((row)=>row.code===item.code)?.rank??null}))};
}

export function initialResult(assetType,payload) {
  const {status}=payload;
  if (ready.has(payload.snapshot_status)) return payload;
  const tagged={...payload,snapshot_status:status};
  if (status==="building") return tagged;
  if (assetType==="stock") {
    if (status==="data_unavailable") return {...tagged,status:"unavailable",rows:[]};
    if (status==="cache_unavailable") return {...tagged,status:"rate_limiter_unavailable",rows:[]};
    return {...tagged,rows:[]};
  }
  if (status==="cache_unavailable") return {...tagged,status:"rate_limiter_unavailable"};
  return tagged;
}
