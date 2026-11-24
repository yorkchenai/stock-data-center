import { resolveSymbol } from "../../web/engine.mjs";
import { createSnapshotCompute } from "./compute.mjs";
import { boundedJson } from "./details.mjs";
import { analysisService } from "./service.mjs";

const PROTOCOL = "2026-07-28";
const symbolSchema={type:"string",description:"六位代码。股票或指数可带 sh/sz 前缀；基金保留前导零。"};
const afterSnapshot={type:"string",description:"仅续查刷新时使用。传回 building 响应的 after_snapshot_id，并省略 refresh。"};
const dates=Object.fromEntries(["start","end","date","before"].map((key)=>[key,{type:"string",format:"date"}]));
const detailsFields={
  asset_type:{enum:["stock","fund"]},symbol:symbolSchema,snapshot_id:{type:"string"},
  kind:{enum:["stock","index","auto"]},category:{enum:["history","indicators","risk","sectors","model"]},
  ...dates,limit:{type:"integer",minimum:1,maximum:120},
  aggregate:{enum:["max","min"]},field:{type:"string"},period:{enum:["1w","1m","3m","6m","1y","3y","5y","all"]},
  index_code:{type:"string"},
};

const tools=[
  {
    name:"get_stock_analysis",description:"股票雷达。将中文逐位代码转为数字。首次返回最近交易日、指标和 snapshot_id；追问使用同一个 ID 调用 get_analysis_details。building 时按代码重试，若返回 after_snapshot_id 须带回该值。传 refresh:true 请求新快照。",
    inputSchema:{type:"object",required:["symbol"],additionalProperties:false,properties:{
      symbol:symbolSchema,start:dates.start,end:dates.end,kind:{enum:["stock","index","auto"]},refresh:{type:"boolean"},after_snapshot_id:afterSnapshot,
    }},
  },
  {
    name:"get_fund_analysis",description:"基金雷达。将中文逐位代码转为数字，保留前导零。首次返回确认净值日期、收益摘要和 snapshot_id；后续用该 ID 查询。building 时按基金代码重试，若返回 after_snapshot_id 须带回该值。缺少行业指数时如实说明。",
    inputSchema:{type:"object",required:["symbol"],additionalProperties:false,
      properties:{symbol:symbolSchema,refresh:{type:"boolean"},after_snapshot_id:afterSnapshot}},
  },
  {
    name:"get_analysis_details",description:"按上一条结果的 snapshot_id 查询。历史与指标支持日期或最近若干条、区间内最高或最低值。风险和关联板块读取已计算结果。快照过期时依照用户要求刷新。",
    inputSchema:{type:"object",required:["asset_type","symbol","snapshot_id","category"],additionalProperties:false,
      properties:detailsFields},
  },
].map((tool)=>({...tool,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}}));

const LIMIT_SQL=`
INSERT INTO analysis_snapshot_limits(slot,minute,calls) VALUES(?,unixepoch()/60,1)
ON CONFLICT(slot) DO UPDATE SET minute=excluded.minute,
calls=CASE WHEN excluded.minute>analysis_snapshot_limits.minute THEN 1 ELSE analysis_snapshot_limits.calls+1 END
WHERE excluded.minute>analysis_snapshot_limits.minute OR analysis_snapshot_limits.calls<?
RETURNING calls`;

async function limit(db, slot, count) {
  try {
    return await db.prepare(LIMIT_SQL).bind(slot,count).first() ? null : "rate_limited";
  } catch {
    return "cache_unavailable";
  }
}

function publicAccess(request, env, args) {
  const origin=request.headers.get("Origin");
  if (!env.SNAPSHOT_PUBLIC_ORIGIN || origin!==env.SNAPSHOT_PUBLIC_ORIGIN) return null;
  if (new URL(origin).protocol!=="https:" && !["localhost","127.0.0.1"].includes(new URL(origin).hostname)) return null;
  let symbol=args.symbol;
  if (args.asset_type==="stock") {
    try {
      const resolved=resolveSymbol(symbol,args.kind??"auto");
      symbol=resolved.market+resolved.code;
    } catch { return null; }
  }
  const approved=(env.SNAPSHOT_PUBLIC_SYMBOLS??"").split(",").includes(`${args.asset_type}:${symbol}`);
  return approved ? {"Access-Control-Allow-Origin":origin,Vary:"Origin"} : null;
}

function json(value, status=200, extra={}) {
  try {
    return new Response(boundedJson(value),{status,headers:{
      "content-type":"application/json; charset=utf-8","cache-control":"private, no-store",
      "x-content-type-options":"nosniff",...extra,
    }});
  } catch {
    return Response.json({status:"response_too_large"},{status:413,headers:{"cache-control":"no-store",...extra}});
  }
}

async function rpcInput(request) {
  if (!request.body) return null;
  const reader=request.body.getReader();
  const decoder=new TextDecoder();
  let total=0,text="";
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) return JSON.parse(text+decoder.decode());
      total+=value.byteLength;
      if (total>8_192) {
        void reader.cancel().catch(()=>{});
        return null;
      }
      text+=decoder.decode(value,{stream:true});
    }
  } catch { return null; }
  finally { reader.releaseLock(); }
}

const statusCode = (status) => ({
  building:202,invalid_arguments:400,snapshot_not_found:404,expired:410,
  rate_limited:429,cache_unavailable:503,data_unavailable:502,
})[status]??200;

export function createSnapshotWorker({calendar,config,modelVersion,authorize=()=>false,compute,clock,observe}) {
  const log=observe??((event)=>console.log(JSON.stringify(event)));
  const service=analysisService({calendar,modelVersion,clock,observe:log,
    compute:compute??createSnapshotCompute({calendar,config,clock,
      observe:(trace)=>log({event:"snapshot_upstream",...trace})})});
  return {
    async fetch(request,env,ctx) {
      const url=new URL(request.url);
      const waitUntil=ctx?.waitUntil?.bind(ctx);
      if (request.method==="GET" && url.pathname==="/api/analysis") {
        const args=Object.fromEntries(url.searchParams);
        if (args.limit) args.limit=Number(args.limit);
        let cors;
        try {cors=publicAccess(request,env,args);} catch {cors=null;}
        if (!cors) return json({status:"access_denied"},403);
        // Public readers have no force-refresh option and share a bounded quota.
        delete args.refresh;
        delete args.after_snapshot_id;
        const blocked=await limit(env.DB,"page",60);
        if (blocked) return json({status:blocked},statusCode(blocked),cors);
        const output=args.snapshot_id
          ? await service.details(env.DB,args,{browser:true})
          : await service.initial(env.DB,args,{waitUntil});
        return json(output,statusCode(output.status),cors);
      }
      if (request.method!=="POST" || url.pathname!=="/mcp") {
        return json({status:"not_found"},404);
      }
      const message=await rpcInput(request);
      const id=message?.id??null;
      const rpc=(result)=>json({jsonrpc:"2.0",id,result});
      const fail=(code,message)=>json({jsonrpc:"2.0",id,error:{code,message}});
      if (message?.jsonrpc!=="2.0") return fail(-32600,"Invalid Request");
      if (message.id===undefined) return new Response(null,{status:202});
      if (message.method==="initialize") return rpc({protocolVersion:message.params?.protocolVersion??PROTOCOL,
        capabilities:{tools:{}},serverInfo:{name:"stock-data-center-snapshots",version:"1.0.0"}});
      if (message.method==="server/discover") return rpc({supportedVersions:[PROTOCOL],capabilities:{tools:{}}});
      if (message.method==="ping") return rpc({});
      if (message.method==="tools/list") return rpc({tools});
      if (message.method!=="tools/call") return fail(-32601,"Method not found");
      const name=message.params?.name;
      const definition=tools.find((entry)=>entry.name===name);
      if (!definition) return fail(-32602,"Unknown tool");
      const pack=(payload)=>rpc({content:[{type:"text",text:boundedJson(payload)}],structuredContent:payload,
        isError:!["complete","partial","building"].includes(payload.status)});
      if (!await authorize(request,env)) return pack({status:"unauthorized"});
      const args=message.params.arguments;
      if (!args || typeof args!=="object" || !definition.inputSchema.required.every((key)=>typeof args[key]==="string") ||
          Object.keys(args).some((key)=>!Object.hasOwn(definition.inputSchema.properties,key)) ||
          (Object.hasOwn(args,"after_snapshot_id") && typeof args.after_snapshot_id!=="string") ||
          (Object.hasOwn(args,"refresh") && typeof args.refresh!=="boolean")) return pack({status:"invalid_arguments"});
      const detail=name==="get_analysis_details";
      const blocked=await limit(env.DB,detail?"owner_details":"owner_initial",detail?30:6);
      if (blocked) return pack({status:blocked});
      if (detail) return pack(await service.details(env.DB,args));
      const asset_type=name==="get_stock_analysis"?"stock":"fund";
      return pack(await service.initial(env.DB,{...args,asset_type},{waitUntil}));
    },
  };
}
