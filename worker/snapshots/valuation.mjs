import { eastmoneyValuation, parseSinaValuationJSONP, sinaValuation, valuationTime, valuationURL } from "../../web/funds/valuation-source.mjs";

async function readValuation(url) {
  const response = await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(5_000)});
  if (!response.ok || !response.body) throw new Error("估值源不可用");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) return text+decoder.decode();
      bytes += value.byteLength;
      if (bytes>512_000) throw new Error("估值源响应超出限制");
      text += decoder.decode(value,{stream:true});
    }
  } finally {
    void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}

export async function fetchPublicValuation(request, allowed, ctx) {
  const origin = request.headers.get("Origin");
  const headers = {Vary:"Origin","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
  if (!allowed || (origin!==null && origin!==allowed)) {
    return Response.json({status:"access_denied"},{status:403,headers});
  }
  if (origin) headers["Access-Control-Allow-Origin"] = allowed;
  const send = (payload,status=200)=>Response.json(payload,{status,headers});
  if (request.method!=="GET") return send({status:"method_not_allowed"},405);
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol"), provider = url.searchParams.get("provider");
  if (url.search.length>80 || [...url.searchParams].length!==2 || !/^\d{6}$/.test(symbol??"") ||
      !["eastmoney","sina"].includes(provider)) return send({status:"invalid_arguments"},400);

  const cache = globalThis.caches?.default;
  url.search = new URLSearchParams({symbol,provider,date:valuationTime().slice(0,10)});
  const key = new Request(url);
  const hit = await cache?.match(key).catch(()=>null);
  if (hit) return new Response(hit.body,{headers:{...headers,"Content-Type":"application/json"}});
  try {
    const upstream = valuationURL(provider,symbol);
    if (provider==="sina") upstream.searchParams.set("_",String(Math.floor(Date.now()/20_000)*20_000));
    const body = await readValuation(upstream);
    const now = valuationTime();
    const values = provider==="sina"
      ? sinaValuation(parseSinaValuationJSONP(body),symbol,now)
      : eastmoneyValuation(JSON.parse(body),symbol,now);
    const data = {symbol,provider,values};
    if (cache && ctx?.waitUntil) {
      const response = Response.json(data,{headers:{"Cache-Control":"public, max-age=20"}});
      ctx.waitUntil(cache.put(key,response).catch(()=>{}));
    }
    return send(data);
  } catch {
    return send({status:"upstream_unavailable",symbol,provider},502);
  }
}
