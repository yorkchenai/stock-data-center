import { resolveSymbol } from "../../web/engine.mjs";
import { createSnapshotCompute } from "./compute.mjs";
import { boundedJson } from "./details.mjs";
import { analysisService } from "./service.mjs";
import { initialResult, prepareInitial } from "./compatibility.mjs";
import { publicError, publicOrigin, publicPresentation, publicQuery } from "./public.mjs";

const PROTOCOL = "2026-07-28";
const symbolSchema={type:"string",description:"六位代码。股票或指数可带 sh/sz 前缀；基金保留前导零。"};
const afterSnapshot={type:"string",description:"仅续查刷新时使用。传回 building 响应的 after_snapshot_id，并省略 refresh。"};
const dates=Object.fromEntries(["start","end","date","before"].map((key)=>[key,{type:"string",format:"date"}]));
const choice=(...values)=>({type:"string",enum:values});
const detailsFields={
  asset_type:choice("stock","fund"),symbol:symbolSchema,snapshot_id:{type:"string"},
  kind:choice("stock","index","auto"),category:choice("history","indicators","risk","sectors","model"),
  ...dates,limit:{type:"integer",minimum:1,maximum:120},
  aggregate:choice("max","min"),field:{type:"string"},period:choice("1w","1m","3m","6m","1y","3y","5y","all"),
  index_code:{type:"string"},
};
const voiceWait="收到 building 时，语音告知仍在构建，最多自动续查一次。保留原参数，若返回 after_snapshot_id 则带回该值，省略 refresh。仍在构建即等待用户追问。";

export const tools=[
  {
    name:"get_stock_analysis",description:"股票雷达。将中文逐位代码转为数字。首次只播报来源、最后交易日、主要指标和数据状态；用相同 snapshot_id 回答追问。"+voiceWait,
    inputSchema:{type:"object",required:["symbol"],additionalProperties:false,properties:{
      symbol:symbolSchema,start:dates.start,end:dates.end,kind:choice("stock","index","auto"),refresh:{type:"boolean"},after_snapshot_id:afterSnapshot,
    }},
  },
  {
    name:"get_fund_analysis",description:"基金雷达。将中文逐位代码转为数字，保留前导零。首次播报来源、确认净值日期、收益和风险摘要。保留 snapshot_id 供追问，并如实说明缺项。"+voiceWait,
    inputSchema:{type:"object",required:["symbol"],additionalProperties:false,
      properties:{symbol:symbolSchema,refresh:{type:"boolean"},after_snapshot_id:afterSnapshot}},
  },
  {
    name:"get_analysis_details",description:"股票和基金雷达的连续追问。使用上一条摘要的 symbol 和 snapshot_id，读取同一快照。history 支持逐日净值或行情，indicators 支持历史指标，risk 支持回撤峰值和谷底日期，sectors 支持 Pearson 相关系数及指定关联指数的逐日行情。",
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

export async function limitSnapshotCalls(db, slot, count) {
  try {
    return await db.prepare(LIMIT_SQL).bind(slot,count).first() ? null : "rate_limited";
  } catch {
    return "cache_unavailable";
  }
}

function approvedSymbol(env, args) {
  let symbol=args.symbol;
  if (args.asset_type==="stock") {
    try {
      const resolved=resolveSymbol(symbol,args.kind??"auto");
      symbol=resolved.market+resolved.code;
    } catch { return false; }
  }
  return (env.SNAPSHOT_PUBLIC_SYMBOLS??"").split(",").includes(`${args.asset_type}:${symbol}`);
}

function isolatedPageAccess(request, env, args) {
  const origin=request.headers.get("Origin");
  return publicOrigin(origin) && origin===env.SNAPSHOT_PUBLIC_ORIGIN && approvedSymbol(env,args)
    ? {"Access-Control-Allow-Origin":origin,Vary:"Origin"} : null;
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
  access_denied:403,version_mismatch:409,
  rate_limited:429,cache_unavailable:503,data_unavailable:502,
})[status]??200;

async function anonymousAnalysis(request, url, env, {service, calendar, clock, modelVersion, requestId, waitUntil}) {
  const origin=request.headers.get("Origin"), allowed=env.SNAPSHOT_PUBLIC_ORIGIN;
  if (!publicOrigin(allowed) || (origin!==null && origin!==allowed)) {
    return json({status:"access_denied"},403,{Vary:"Origin"});
  }
  const cors={Vary:"Origin",...(origin?{"Access-Control-Allow-Origin":allowed}:{})};
  const send=(output)=>json(output,statusCode(output.status),{
    ...cors,...(output.retry_after_seconds?{"Retry-After":String(output.retry_after_seconds)}:{}),
  });
  if (request.method!=="GET") return json({status:"method_not_allowed"},405,{...cors,Allow:"GET"});
  if (url.search.length>512) return json({status:"invalid_arguments"},414,cors);
  const args=Object.fromEntries(url.searchParams);
  try {publicQuery(url,args,calendar,clock());} catch(error) {
    return send(publicError("invalid_arguments",error.message));
  }
  if (env.SNAPSHOT_PUBLIC_SYMBOLS && !approvedSymbol(env,args)) {
    return send(publicError("access_denied","该标的不在公开查询范围。"));
  }
  const {present,select}=publicPresentation(modelVersion);
  const output=args.snapshot_id ? await service.details(env.DB,args,{browser:true,select,requestId}) :
    await service.initial(env.DB,args,{waitUntil,requestId,present});
  return send(output);
}

export function createSnapshotWorker({calendar,config,modelVersion,authorize=()=>false,authorizePage=()=>false,
  pageAccess=async(request,env,args)=>await authorizePage(request,env)?isolatedPageAccess(request,env,args):null,
  initialRateLimit=(db)=>limitSnapshotCalls(db,"owner_initial",6),compute,clock=()=>new Date(),observe}) {
  const log=observe??((event)=>console.log(JSON.stringify(event)));
  const service=analysisService({calendar,modelVersion,clock,observe:log,
    compute:compute??createSnapshotCompute({calendar,config,clock})});
  return {
    async fetch(request,env,ctx) {
      const url=new URL(request.url);
      const waitUntil=ctx?.waitUntil?.bind(ctx);
      const requestId=crypto.randomUUID();
      if (url.pathname==="/api/analysis" && env.SNAPSHOT_PUBLIC_ENABLED==="1") {
        return anonymousAnalysis(request,url,env,{service,calendar,clock,modelVersion,requestId,waitUntil});
      }
      if (request.method==="GET" && url.pathname==="/api/analysis") {
        const args=Object.fromEntries(url.searchParams);
        if (args.limit) args.limit=Number(args.limit);
        let pageHeaders;
        try {pageHeaders=await pageAccess(request,env,args);} catch {pageHeaders=null;}
        if (!pageHeaders) return json({status:"access_denied"},403);
        // The private page view has no force-refresh option.
        delete args.refresh;
        delete args.after_snapshot_id;
        const blocked=await limitSnapshotCalls(env.DB,"page",60);
        if (blocked) return json({status:blocked},statusCode(blocked),pageHeaders);
        const output=args.snapshot_id
          ? await service.details(env.DB,args,{browser:true,requestId})
          : await service.initial(env.DB,args,{waitUntil,requestId});
        return json(output,statusCode(output.status),pageHeaders);
      }
      if (request.method!=="POST" || url.pathname!=="/mcp") {
        return json({status:"not_found"},404);
      }
      const message=await rpcInput(request);
      const id=message?.id??null;
      const rpc=(result)=>json({jsonrpc:"2.0",id,result},200,{"x-analysis-request-id":requestId});
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
      const detail=name==="get_analysis_details";
      const assetType=name==="get_stock_analysis"?"stock":"fund";
      const pack=(payload)=>{
        const structuredContent=detail?payload:initialResult(assetType,payload);
        const {rows,...summary}=structuredContent;
        return rpc({content:[{type:"text",text:boundedJson(summary)}],structuredContent,
          isError:!["complete","partial","building","ok","stale","suspended"].includes(structuredContent.status)});
      };
      const finish=(payload)=>{
        log({event:"snapshot_request",request_id:requestId,tool:name,status:payload.status,
          snapshot_id:payload.snapshot_id,cache:payload.cache});
        return pack(payload);
      };
      if (!await authorize(request,env)) return pack({schema_version:1,status:"unauthorized"});
      const args=message.params.arguments;
      if (!args || typeof args!=="object" || !definition.inputSchema.required.every((key)=>typeof args[key]==="string") ||
          Object.keys(args).some((key)=>!Object.hasOwn(definition.inputSchema.properties,key)) ||
          (Object.hasOwn(args,"after_snapshot_id") && typeof args.after_snapshot_id!=="string") ||
          (Object.hasOwn(args,"refresh") && typeof args.refresh!=="boolean")) return pack({schema_version:1,status:"invalid_arguments"});
      let initial;
      if (!detail) {
        try {initial=prepareInitial(assetType,args,calendar,clock());}
        catch (error) {return pack({schema_version:1,status:"invalid_arguments",message:error.message});}
      }
      const blocked=detail?await limitSnapshotCalls(env.DB,"owner_details",30):await initialRateLimit(env.DB);
      if (blocked) return pack({schema_version:1,status:blocked});
      if (detail) return finish(await service.details(env.DB,args,{requestId}));
      const output=await service.initial(env.DB,initial.args,{waitUntil,requestId,present:initial.present});
      if (output.status==="building") {
        output.max_voice_auto_retries=1;
        log({event:"snapshot_building",request_id:requestId,symbol:output.symbol});
      }
      return finish(output);
    },
  };
}
