import { authenticate, login, logout } from "./auth.mjs";
import { calculatePortfolio, decimal, fixed, shanghaiDay, validDay } from "./ledger.mjs";
import { portfolioConfirmedNav, portfolioFundName, portfolioMarket } from "./market.mjs";
import { auditFor, backupLedger, changeTransaction, createTransaction, readLedger, restoreLedger, saveSetting, uuid } from "./store.mjs";

const security = {
  "Cache-Control":"private, no-store",
  "Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options":"nosniff",
  "X-Frame-Options":"DENY",
  "Referrer-Policy":"no-referrer",
  "Permissions-Policy":"camera=(), microphone=(), geolocation=()",
};

const reply = (body,status=200,extra={}) => Response.json(body,{status,headers:{...security,...extra}});
const fail = (error,status) => reply({error},status);

class InputError extends Error {}

async function readJSON(request,max=16_000) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("Content-Type")??""))
    throw new InputError("请提交 JSON 请求。");
  if (!request.body || Number(request.headers.get("Content-Length"))>max) throw new InputError("请求内容超出大小限制。");
  const reader=request.body.getReader(), decoder=new TextDecoder("utf-8",{fatal:true});
  let bytes=0, text="";
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes>max) throw new InputError("请求内容超出大小限制。");
      text += decoder.decode(value,{stream:true});
    }
    const value=JSON.parse(text+decoder.decode());
    if (!value || typeof value!=="object" || Array.isArray(value)) throw new InputError("请求格式无效。");
    return value;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("请求 JSON 格式无效。");
  } finally {
    void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}

async function userInput(action) {
  try { return await action(); }
  catch (error) {
    // Validation errors are generated locally. Storage diagnostics stay out of responses and logs.
    if (typeof error.message==="string" && /^[\p{Script=Han}]/u.test(error.message)) throw new InputError(error.message);
    throw error;
  }
}

async function serveAssets(request,env,path) {
  if (!["GET","HEAD"].includes(request.method) ||
      !["/","/index.html","/portfolio.css","/portfolio.mjs","/chart.mjs","/amounts.mjs"].includes(path)) return fail("not_found",404);
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  for (const [name,value] of Object.entries(security)) headers.set(name,value);
  return new Response(response.body,{status:response.status,headers});
}

const isFund = (code) => /^\d{6}$/.test(code);
const quoteLimit = 10;

function knownCodes(ledger) {
  return [...new Set(ledger.records.flatMap((row)=>row.status === "confirmed" && row.related_fund_code
    ? [row.fund_code,row.related_fund_code] : [row.fund_code]))];
}

export function createPortfolioWorker({market=portfolioMarket,fundName=portfolioFundName,
  confirmedNav=portfolioConfirmedNav,now=()=>new Date()}={}) {
  return {
    async fetch(request,env,ctx) {
      const url=new URL(request.url);
      const {pathname:path}=url;
      if (!path.startsWith("/api/")) return serveAssets(request,env,path);
      try {
        const method=request.method, writing=["POST","PUT","DELETE"].includes(method);
        if (writing && request.headers.get("Origin")!==url.origin) return fail("bad_origin",403);
        if (!env.PORTFOLIO_DB) return fail("not_configured",503);
        const clock=now(), second=Math.floor(clock.getTime()/1000);
        if (path==="/api/login" && method==="POST") {
          const result=await login(await readJSON(request,2_048),env,second);
          if (result.cookie) return reply({authenticated:true},200,{"Set-Cookie":result.cookie});
          return reply({error:result.error},result.status,result.retry ? {"Retry-After":String(result.retry)} : {});
        }
        const session=await authenticate(request,env,second);
        if (!session) return fail("unauthorized",401);
        const db=env.PORTFOLIO_DB, timestamp=clock.toISOString(), day=shanghaiDay(clock);
        if (path==="/api/session" && method==="GET") return reply({authenticated:true});
        if (path==="/api/logout" && method==="POST") return reply({authenticated:false},200,{"Set-Cookie":await logout(session,db)});
        if (path==="/api/ledger" && method==="GET") return reply(await readLedger(db));
        if (method==="GET" && /^\/api\/fund-entry\/\d{6}$/.test(path)) {
          const code=path.slice(-6);
          const date=url.searchParams.get("date");
          if (date===null) return reply({code,name:await fundName(code)});
          if (!validDay(date) || date>day) throw new InputError("请选择有效的申请日期。");
          const dataset=await confirmedNav(code,request,ctx,day);
          if (!dataset) return fail("service_unavailable",503);
          const raw=dataset.rows.find((row)=>row.date===date)?.unit_nav;
          const value=raw == null ? null : fixed(String(raw),6);
          return reply({code,date,unit_nav:value>0n?decimal(value,6):null,source:dataset.source});
        }
        if (path==="/api/transactions" && method==="POST") {
          const input=await readJSON(request);
          const transaction=await userInput(()=>createTransaction(db,input,timestamp));
          return transaction ? reply(transaction,201) : fail("ledger_full",409);
        }
        if (path.startsWith("/api/transactions/")) {
          const [, , ,id,action,...extra]=path.split("/");
          if (!uuid.test(id) || extra.length) return fail("not_found",404);
          if (action==="audit" && method==="GET") return reply({audit:await auditFor(db,id)});
          if (!action && ["PUT","DELETE"].includes(method)) {
            const input=await readJSON(request);
            if (!Number.isSafeInteger(input.revision) || input.revision<1 || (method==="PUT" && !input.transaction))
              throw new InputError("缺少交易版本或记录内容。");
            const transaction=await userInput(()=>changeTransaction(db,id,method==="DELETE"?null:input.transaction,input.revision,timestamp));
            return transaction ? reply(transaction) : fail("revision_conflict",409);
          }
        }
        if (path.startsWith("/api/settings/") && method==="PUT") {
          const code=path.slice("/api/settings/".length);
          const input=await readJSON(request);
          if (!isFund(code) || typeof input.history_complete!=="boolean") throw new InputError("基金代码或流水完整性设置无效。");
          const ledger=await readLedger(db);
          if (!knownCodes(ledger).includes(code)) return fail("not_found",404);
          return reply(await saveSetting(db,code,input.history_complete));
        }
        if (path==="/api/backup" && method==="GET") {
          return reply(await backupLedger(db,timestamp),200,
            {"Content-Disposition":`attachment; filename="fund-portfolio-${day}.json"`});
        }
        if (path==="/api/restore" && method==="POST") {
          const input=await readJSON(request,4_000_000);
          return await userInput(()=>restoreLedger(db,input,timestamp)) ? reply({restored:true},201) : fail("ledger_not_empty",409);
        }
        if (method==="GET" && (path==="/api/summary" || /^\/api\/funds\/\d{6}$/.test(path))) {
          const ledger=await readLedger(db), codes=knownCodes(ledger);
          const code=path==="/api/summary" ? null : path.slice(-6);
          if (code && !codes.includes(code)) return fail("not_found",404);
          const markets=new Map(), selected=code ? [code] : codes.slice(0,quoteLimit);
          // Bound fan-out so request volume stays below the free Workers subrequest limit.
          for (let offset=0;offset<selected.length;offset+=5) {
            await Promise.all(selected.slice(offset,offset+5).map(async (symbol)=>{
              const data=await market(symbol,request,ctx,day).catch(()=>null);
              if (data) markets.set(symbol,data);
            }));
          }
          const result=calculatePortfolio(ledger.records,ledger.settings,markets,day);
          if (!code) return reply(result);
          const fund=result.funds.find((item)=>item.code===code);
          const history=markets.get(code)?.rows ?? [];
          return reply({fund,history,transactions:ledger.records.filter((row)=>row.fund_code===code || row.related_fund_code===code)});
        }
        return fail("not_found",404);
      } catch (error) {
        if (error instanceof InputError) return reply({error:"invalid_input",message:error.message},400);
        return fail("service_unavailable",503);
      }
    },
  };
}

export default createPortfolioWorker();
