const pendingKey="stock-data-center.watchlist-return.v1";
const callbackPrefix="#sdc-watchlist=";
const noncePattern=/^[a-f0-9]{32}$/;
const expiry=15*60_000;

function pendingRequest() {
  try {
    const request=JSON.parse(sessionStorage.getItem(pendingKey)??"null");
    const age=Date.now()-request?.started;
    return noncePattern.test(request?.nonce) && age>=0 && age<=expiry ? request : null;
  } catch { return null; }
}

export function watchlistSyncPending() { return pendingRequest()!==null; }

export function startWatchlistSync(managementUrl,replace=false) {
  try {
    const nonce=Array.from(crypto.getRandomValues(new Uint8Array(16)),
      (byte)=>byte.toString(16).padStart(2,"0")).join("");
    const url=new URL("sync/"+nonce+"/",managementUrl);
    sessionStorage.setItem(pendingKey,JSON.stringify({nonce,started:Date.now()}));
    if (replace) location.replace(url);
    else location.assign(url);
    return true;
  } catch { return false; }
}

// Only the matching browser tab can accept a fresh return. No codes are stored on this origin.
export function consumeWatchlistSync() {
  const url=new URL(location.href);
  if (!url.hash.startsWith(callbackPrefix)) return undefined;
  const callback=url.hash.slice(callbackPrefix.length);
  url.hash="";
  history.replaceState(history.state,"",url);
  const match=/^([a-f0-9]{32})\.(.*)$/.exec(callback);
  if (!match || pendingRequest()?.nonce!==match[1]) return null;
  try { sessionStorage.removeItem(pendingKey); } catch { return null; }
  const codes=match[2]?match[2].split(","):[];
  if (codes.length>200 || codes.some((code)=>!/^\d{6}$/.test(code))) return null;
  return [...new Set(codes)];
}
