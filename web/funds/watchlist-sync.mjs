const pendingKey="stock-data-center.fund-list-return.v1";
const callbackPrefix="#sdc-fund-list=";
const expiry=15*60_000;

function pendingRequest() {
  try {
    const request=JSON.parse(sessionStorage.getItem(pendingKey)??"null");
    const age=Date.now()-request?.started;
    return /^[a-f0-9]{32}$/.test(request?.nonce) && age>=0 && age<=expiry ? request : null;
  } catch { return null; }
}

export function watchlistSyncPending() { return pendingRequest()!==null; }

export function startWatchlistSync(managementUrl,replace=false,edit) {
  try {
    const nonce=crypto.randomUUID().replaceAll("-","");
    const url=new URL("library/"+nonce+"/",managementUrl);
    if (edit) url.hash="sdc-fund-edit="+encodeURIComponent(JSON.stringify(edit));
    sessionStorage.setItem(pendingKey,JSON.stringify({nonce,started:Date.now(),scrollY,action:edit?.action.kind}));
    if (replace) location.replace(url);
    else location.assign(url);
    return true;
  } catch { return false; }
}

// Only the requesting tab accepts the callback. Codes and capability stay in memory.
export function consumeWatchlistSync() {
  const url=new URL(location.href);
  if (!url.hash.startsWith(callbackPrefix) && !url.hash.startsWith("#sdc-watchlist=")) return undefined;
  const callback=url.hash;
  url.hash="";
  history.replaceState(history.state,"",url);
  if (!callback.startsWith(callbackPrefix)) return undefined;
  const request=pendingRequest();
  const match=/^([a-f0-9]{32})\.(.*)$/.exec(callback.slice(callbackPrefix.length));
  if (!match || request?.nonce!==match[1]) return null;
  try {
    sessionStorage.removeItem(pendingKey);
    const {rows,token,error}=JSON.parse(decodeURIComponent(match[2]));
    if (!Array.isArray(rows) || rows.length>200 || !rows.every((row)=>typeof row==="string" && /^\d{6}[01]$/.test(row)) ||
        typeof token!=="string" || !/^[a-f0-9-]{36}$/.test(token)) return null;
    return {entries:rows.map((row)=>({code:row.slice(0,6),favorite:row[6]==="1"})),
      token,error:typeof error==="string"?error:null,scrollY:request.scrollY,action:request.action};
  } catch { return null; }
}
