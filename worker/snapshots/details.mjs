import { FIELDS, validDate } from "../../web/engine.mjs";

export const SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATEGORIES = new Set(["history","indicators","risk","sectors","model","index","page"]);
const PERIODS = new Set(["1w","1m","3m","6m","1y","3y","5y","all"]);
const PRESENTATION_BYTES = 4_000_000;

export function snapshotMetadata(snapshot) {
  const {snapshot_id,asset_type,symbol,schema_version,model_version,status,source,data_as_of,
    computed_at,expires_at} = snapshot;
  return {snapshot_id,asset_type,symbol,schema_version,model_version,status,source,data_as_of,computed_at,expires_at};
}

function filterRows(rows, args) {
  const date=args.date ? validDate(args.date) : null;
  const start=args.start ? validDate(args.start) : null;
  const end=args.end ? validDate(args.end) : null;
  const before=args.before ? validDate(args.before) : null;
  const limit=args.limit??20;
  if (!Number.isInteger(limit) || limit<1 || limit>120 || (start&&end&&start>end) ||
      (date&&(start||end||before))) throw new Error("无效的历史查询范围或条数。");
  const rowsInRange=rows.filter((row)=>(!date||row.date===date)&&(!start||row.date>=start)&&
    (!end||row.date<=end)&&(!before||row.date<before));
  const selected=args.aggregate && !Object.hasOwn(args,"limit") && (start || end)
    ? rowsInRange:rowsInRange.slice(-limit);
  return {rows:selected,count:selected.length,first:selected[0]?.date??null,last:selected.at(-1)?.date??null,
    next_before:rowsInRange.length>selected.length?selected[0].date:null};
}

function extreme(rows, field, mode) {
  if (!["max","min"].includes(mode) || typeof field!=="string" || !rows.some((row)=>Object.hasOwn(row,field))) {
    throw new Error("所选字段或极值类型不可用。");
  }
  let best=null;
  for (const row of rows) {
    const value=row[field];
    if (!Number.isFinite(value)) continue;
    if (!best || (mode==="max" ? value>best.value : value<best.value)) best={date:row.date,value};
  }
  return best;
}

export function selectDetails(snapshot, args, {browser=false}={}) {
  const {category} = args;
  if (!CATEGORIES.has(category) || (!browser && ["page","index"].includes(category))) {
    throw new Error("详情类别无效。");
  }
  const stock=snapshot.asset_type==="stock";
  const meta=snapshotMetadata(snapshot);
  let result;
  if (category==="history" || category==="indicators") {
    const rows=category==="history" ? snapshot.raw_data.history : snapshot.indicators.rows;
    if (!rows) return {...meta,category,detail_status:"unavailable"};
    result=filterRows(rows,args);
    if (category==="indicators") {
      result.rows=result.rows.map((row)=>Object.fromEntries(
        Object.entries(row).filter(([name])=>name==="date"||!FIELDS.includes(name))));
    }
    if (args.date && !result.count) return {...meta,category,detail_status:"no_observation",data:result};
    if (args.aggregate && result.count) {
      result.extreme=extreme(result.rows,args.field,args.aggregate);
      delete result.rows;
    }
  } else if (category==="risk") {
    const period=args.period??"1y";
    if (!PERIODS.has(period)) throw new Error("无效的风险统计区间。");
    const risk=snapshot.models.risk;
    if (risk) {
      const {points,...window}=risk.windows[period];
      result={...window,period,observations_per_year:risk.observations_per_year,
        return_basis:risk.return_basis,sortino_target:risk.sortino_target};
    }
  } else if (category==="sectors") {
    const report=snapshot.models.sectors?.report;
    if (report) {
      const {profiles,models,...summary}=report;
      const code=args.index_code;
      if (code) {
        if (!/^[0-9A-Z]{6}$/.test(code)) throw new Error("指数代码无效。");
        const history=snapshot.raw_data.sector_index_history[code];
        const chart=snapshot.models.sectors.charts[code];
        result={index_coverage:report.index_coverage,profile:profiles?.[code]??null,
          ranked:report.sectors.find((index)=>index.code===code)??null,
          history:history ? {...filterRows(history.rows,args),source:history.source} : null,
          chart:chart ? {...filterRows(chart.rows,args),source:chart.source,last_index_trade_date:chart.last,
            volume_unit:chart.volume_unit} : null};
      } else {
        result={...summary,models};
      }
    }
  } else if (category==="model") {
    result={quality:snapshot.quality,models:stock ? snapshot.models : {
      risk_periods:Object.keys(snapshot.models.risk.windows),
      benchmark:snapshot.raw_data.fund.benchmark_disclosure??snapshot.raw_data.fund.benchmark??null,
      sector_status:snapshot.quality.sector_status,
    }};
  } else if (category==="index") {
    result=snapshot.models.sectors?.charts[args.index_code];
  } else if (stock) {
    result={...snapshot.raw_data.stock,rows:snapshot.indicators.rows};
  } else {
    result={fund:{...snapshot.raw_data.fund,rows:snapshot.raw_data.history},
      risk:snapshot.models.risk,association:snapshot.models.sectors.report};
  }
  return {...meta,category,detail_status:result ? "available" : "unavailable",data:result??null};
}

export function boundedJson(value) {
  const text=JSON.stringify(value);
  if (new TextEncoder().encode(text).length>PRESENTATION_BYTES) throw new Error("详情响应过大，请缩小查询范围。");
  return text;
}
