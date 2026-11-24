const FUND_ORIGIN = "https://fund.eastmoney.com";
const indexPaths = new Map([
  ["https://www.csindex.com.cn", "/csindex-home/perf/index-perf"],
  ["https://push2his.eastmoney.com", "/api/qt/stock/kline/get"],
  ["https://proxy.finance.qq.com", "/ifzqgtimg/appstock/app/newfqkline/get"],
]);

export function marketTransport(fetcher = fetch, observe = () => {}) {
  return async (input, {signal, timeout=8_000}={}) => {
    const url = new URL(input);
    const allowed = url.origin === FUND_ORIGIN
      ? url.pathname === "/js/fundcode_search.js" || /^\/pingzhongdata\/\d{6}\.js$/.test(url.pathname)
      : indexPaths.get(url.origin) === url.pathname;
    if (!allowed || url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error("不支持的数据源地址。");
    }
    const deadline = AbortSignal.timeout(timeout);
    const combined = signal ? AbortSignal.any([signal,deadline]) : deadline;
    combined.throwIfAborted();
    const trace = {provider:url.hostname, path:url.pathname,
      symbol:url.searchParams.get("secid") ?? url.searchParams.get("indexCode") ??
        url.searchParams.get("param")?.split(",")[0] ?? null};
    try {
      const response = await fetcher(url.href,{signal:combined,redirect:"manual",cache:"no-store"});
      trace.http = response.status;
      if (response.type==="opaqueredirect" || response.redirected ||
          (response.status>=300 && response.status<400) || (response.url && response.url!==url.href)) {
        void response.body?.cancel().catch(()=>{});
        throw new Error("数据源重定向");
      }
      if (!response.ok || !response.body) {
        void response.body?.cancel().catch(()=>{});
        throw new Error(`HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8",{fatal:true});
      let text = "", bytes = 0;
      try {
        for (;;) {
          const {done,value}=await reader.read();
          if (done) return text+decoder.decode();
          bytes += value.byteLength;
          if (bytes > 4_000_000) throw new Error("数据源响应超出大小限制。");
          text += decoder.decode(value,{stream:true});
        }
      } catch (error) {
        void reader.cancel().catch(()=>{});
        throw error;
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      trace.error=error.name==="TimeoutError" || error.name==="AbortError" ? "timeout" : error.message;
      throw error;
    } finally {
      observe(trace);
    }
  };
}
