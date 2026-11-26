export const eastmoney = "https://fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast";
export const sina = "https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic";
const shanghaiTime = new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Shanghai",
  year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
export const sources = {
  fundgz:["天天基金","FundValuationLast 平台估算"],
  sina_ds2:["新浪财经","ds2 估算序列"],
  sina_ds3:["新浪财经","ds3 估算序列"],
};

function number(value) {
  return typeof value === "number" || (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim()))
    ? Number(value) : NaN;
}

export function quote(id, value, change, updatedAt, asOf) {
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

export function valuationTime() {
  return shanghaiTime.format(new Date());
}

export function valuationURL(provider, code) {
  const url = new URL(provider==="sina" ? sina : eastmoney);
  url.search = provider==="sina"
    ? new URLSearchParams({symbol:code,callback:"sdcFundValuation"})
    : new URLSearchParams({FCODES:code,FIELDS:"FCODE,GSZ,GSZZL,GZTIME"});
  return url;
}

export function parseSinaValuationJSONP(body) {
  const match = body.match(/^\s*(?:\/\*[^]*?\*\/\s*)?sdcFundValuation\s*\(([^]*)\)\s*;?\s*$/);
  if (!match) throw new Error("新浪估值响应不是预期的 JSONP");
  return JSON.parse(match[1]);
}
