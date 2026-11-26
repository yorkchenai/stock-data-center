import { FUND_CODE, shanghaiToday } from "./data.mjs";
import { readFundText } from "./providers.mjs";

const eastmoney = "https://fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast";
const sina = "https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic";
const shanghaiTime = new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Shanghai",
  year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
const sources = {
  fundgz:["天天基金","FundValuationLast 平台估算"],
  sina_ds2:["新浪财经","ds2 估算序列"],
  sina_ds3:["新浪财经","ds3 估算序列"],
};

function number(value) {
  return typeof value === "number" || (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim()))
    ? Number(value) : NaN;
}

function quote(id, value, change, updatedAt, asOf) {
  if (typeof updatedAt!=="string" || updatedAt.slice(0,10)!==asOf.slice(0,10) ||
      !/^ (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(updatedAt.slice(10))) return null;
  const time = updatedAt.length===16 ? updatedAt+":00" : updatedAt;
  if (time>asOf || !Number.isFinite(value) || value<=0 || !Number.isFinite(change)) return null;
  const [source,method] = sources[id];
  return {id,value,change,updatedAt,source,method};
}

export function eastmoneyValuation(payload, code, asOf) {
  if (payload?.success!==true || !Array.isArray(payload.data)) throw new Error("天天基金估值响应无效");
  const row = payload.data.find((item)=>item?.FCODE===code);
  if (!row) return [];
  const result = quote("fundgz",number(row.GSZ),number(row.GSZZL),row.GZTIME,asOf);
  return result ? [result] : [];
}

export function sinaValuation(payload, code, asOf) {
  const result = payload?.result;
  if (result?.status?.code!==0) throw new Error("新浪估值响应无效");
  const reported = result.data?.symbol ?? result.data?.fundcode;
  if (reported != null && String(reported)!==code) throw new Error("新浪估值返回了其他基金");
  const rows = result.data?.networth;
  if (rows == null) return [];
  if (!Array.isArray(rows)) throw new Error("新浪估值序列无效");
  return [2,3].flatMap((series)=>{
    const suffix = series===2 ? "" : "2";
    let newest;
    for (const row of rows) {
      const point = quote("sina_ds"+series,number(row?.["pre_nav"+suffix]),number(row?.["growthrate"+suffix])*100,
        `${row?.pre_date ?? ""} ${row?.min_time ?? ""}`,asOf);
      if (point && (!newest || point.updatedAt>=newest.updatedAt)) newest = point;
    }
    return newest ? [newest] : [];
  });
}

// Sina's endpoint has no CORS. Execute the fixed JSONP URL in an opaque sandbox, as with legacy fund NAV scripts.
function readSinaValuation(url, signal) {
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const frame = document.createElement("iframe");
    frame.sandbox = "allow-scripts";
    frame.referrerPolicy = "no-referrer";
    frame.credentialless = true;
    frame.hidden = true;
    const nonce = crypto.randomUUID();
    function finish(error,payload) {
      clearTimeout(timer);
      signal.removeEventListener("abort",cancel);
      window.removeEventListener("message",receive);
      frame.remove();
      if (error) reject(error);
      else resolve(payload);
    }
    function cancel() { finish(signal.reason); }
    function receive(event) {
      if (event.source!==frame.contentWindow || event.origin!=="null" || event.data?.nonce!==nonce) return;
      const payload = event.data.payload;
      finish(payload ? null : new Error("新浪估值加载失败"),payload);
    }
    const timer = setTimeout(()=>finish(new Error("新浪估值加载超时")),12_000);
    signal.addEventListener("abort",cancel,{once:true});
    window.addEventListener("message",receive);
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'nonce-${nonce}' ${sina}">
      <script nonce="${nonce}">
        const send=(payload)=>parent.postMessage({nonce:${JSON.stringify(nonce)},payload},"*");
        let called=false;
        window.sdcFundValuation=(payload)=>{
          if (called) return;
          called=true;
          const result=payload?.result;
          const data=result?.data;
          const rows=data?.networth;
          if (Array.isArray(rows) && rows.length>2000) return send(null);
          const scalar=(value)=>typeof value==="number" || (typeof value==="string" && value.length<=40) ? value : null;
          const pick=(row)=>Object.fromEntries(["pre_date","min_time","pre_nav","growthrate","pre_nav2","growthrate2"]
            .map((field)=>[field,scalar(row?.[field])]));
          send({result:{status:{code:scalar(result?.status?.code)},data:{
            symbol:scalar(data?.symbol ?? data?.fundcode),
            networth:Array.isArray(rows) ? rows.map(pick) : scalar(rows),
          }}});
        };
        const script=document.createElement("script");
        script.src=${JSON.stringify(url)};
        script.referrerPolicy="no-referrer";
        script.onload=()=>{if (!called) send(null);};
        script.onerror=()=>send(null);
        document.head.append(script);
      <\/script>`;
    document.body.append(frame);
  });
}

export async function fetchValuation(code, signal) {
  if (!FUND_CODE.test(code)) throw new Error("请输入六位基金代码");
  let eastFailed = false;
  const params = new URLSearchParams({FCODES:code,FIELDS:"FCODE,GSZ,GSZZL,GZTIME"});
  try {
    const data = JSON.parse(await readFundText(eastmoney+"?"+params,{signal}));
    const values = eastmoneyValuation(data,code,shanghaiTime.format(new Date()));
    if (values.length) return values;
  } catch {
    signal.throwIfAborted();
    eastFailed = true;
  }
  const url = sina+"?"+new URLSearchParams({symbol:code,callback:"sdcFundValuation",_:String(Date.now())});
  const values = sinaValuation(await readSinaValuation(url,signal),code,shanghaiTime.format(new Date()));
  if (!values.length && eastFailed) throw new Error("估值来源暂不可用");
  return values;
}

export function watchValuation(render) {
  const cache = new Map();
  let code, controller, timer;

  function pause() {
    clearTimeout(timer);
    controller?.abort();
    controller = null;
  }

  async function refresh() {
    if (!code || document.hidden || controller) return;
    clearTimeout(timer);
    timer = setTimeout(refresh,60_000);
    const request = controller = new AbortController();
    const symbol = code;
    const previous = ()=> (cache.get(symbol) ?? []).filter(({updatedAt})=>updatedAt.startsWith(shanghaiToday()+" "));
    render(previous(),"正在更新估值…",true);
    try {
      const values = await fetchValuation(symbol,request.signal);
      if (controller!==request) return;
      cache.set(symbol,values);
      render(previous(),"",false);
    } catch {
      if (controller!==request) return;
      const values = previous();
      render(values,values.length ? "更新失败 · 保留上次成功估值" : "更新失败",false);
    } finally {
      if (controller===request) controller = null;
    }
  }

  document.addEventListener("visibilitychange",()=>{
    if (document.hidden) pause();
    else void refresh();
  });
  return {refresh,select(symbol) {
    pause();
    code = symbol;
    render([],"",false);
    void refresh();
  }};
}
