import { chromium } from "playwright-core";

const origin = "https://yorkchenai.github.io/stock-data-center/";
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH??"/usr/bin/chromium",
  args:["--no-sandbox"]});
const report = {origin, checked_at:new Date().toISOString(), http:{}};
try {
  const page = await browser.newPage();
  page.on("response", (response)=>{
    const url = new URL(response.url());
    if (!["fundmobapi.eastmoney.com","fund.eastmoney.com","www.csindex.com.cn"].includes(url.hostname)) return;
    report.http[url.host+url.pathname+"?"+(url.searchParams.get("FCODE")??url.searchParams.get("indexCode")??"")] =
      {status:response.status(), allow_origin:response.headers()["access-control-allow-origin"]??null};
  });
  const pageResponse = await page.goto(origin,{waitUntil:"domcontentloaded",timeout:25_000});
  report.page_status = pageResponse.status();
  report.data = await page.evaluate(async ()=>{
    const codes = ["110022","006751","003095"];
    async function read(url, inspect) {
      try {
        const response = await fetch(url,{mode:"cors",credentials:"omit",signal:AbortSignal.timeout(10_000)});
        if (!response.ok) return {status:"http_error",http:response.status};
        return {status:"cors_readable",...await inspect(response)};
      } catch (error) {
        return {status:error.name==="TimeoutError"?"timeout":
          error instanceof SyntaxError?"invalid_response":"cors_or_network_error"};
      }
    }
    const directory = read("https://fund.eastmoney.com/js/fundcode_search.js",async(response)=>({bytes:(await response.text()).length}));
    const csi = read("https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=932075&startDate=20261001&endDate=20261123",
      async(response)=>({count:(await response.json()).data?.length??null}));
    const mobile = async (code)=>{
      const root="https://fundmobapi.eastmoney.com/FundMNewApi/";
      const profile=read(root+"FundMNDetailInformation?"+new URLSearchParams({FCODE:code,plat:"Android",product:"EFund",version:"6.3.8"}),
        async(response)=>{const p=await response.json();return {vendor_error:p.ErrCode,fields:Object.keys(p.Datas??{})};});
      const history=await read(root+"FundMNHisNetList?"+new URLSearchParams({FCODE:code,pageIndex:"1",pageSize:"3",plat:"Android",product:"EFund",version:"6.3.8"}),
        async(response)=>{const p=await response.json();return {vendor_error:p.ErrCode,total:p.TotalCount??null,rows:p.Datas?.length??null,fields:Object.keys(p.Datas?.[0]??{})};});
      return {code,profile:await profile,history};
    };
    const direct = codes.map((code)=>read(`https://fund.eastmoney.com/pingzhongdata/${code}.js`,
      async(response)=>({code,bytes:(await response.text()).length})));
    const mobileResults = await Promise.all(codes.map(mobile));
    const directResults = await Promise.all(direct);
    const isolated=[];
    for (const code of codes) {
      isolated.push(await new Promise((resolve)=>{
        const frame=document.createElement("iframe");
        frame.sandbox="allow-scripts";
        frame.hidden=true;
        frame.credentialless=true;
        const nonce=crypto.randomUUID();
        const finish=(value)=>{
          clearTimeout(timer);window.removeEventListener("message",receive);frame.remove();resolve({code,...value});
        };
        function receive(event){
          if(event.origin==="null"&&event.source===frame.contentWindow&&event.data?.nonce===nonce) finish(event.data.summary);
        }
        const timer=setTimeout(()=>finish({status:"timeout"}),12_000);
        window.addEventListener("message",receive);
        frame.srcdoc=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://fund.eastmoney.com/pingzhongdata/">
          <script src="https://fund.eastmoney.com/pingzhongdata/${code}.js"></script><script nonce="${nonce}">
          const rows=window.Data_netWorthTrend;
          const day=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai"});
          parent.postMessage({nonce:${JSON.stringify(nonce)},summary:{
            status:window.fS_code===${JSON.stringify(code)}&&rows?.length?"ok":"invalid_or_unavailable",
            received:window.fS_code??null,history:rows?.length??null,accumulated:window.Data_ACWorthTrend?.length??null,
            fields:Object.keys(rows?.at(-1)??{}),first:rows?.length?day.format(new Date(rows[0].x)):null,
            last:rows?.length?day.format(new Date(rows.at(-1).x)):null
          }},"*")<\/script>`;
        document.body.append(frame);
      }));
    }
    return {origin:location.origin,csi:await csi,directory:await directory,mobile:mobileResults,direct:directResults,isolated};
  });
} catch (error) {
  report.error=String(error.message).split("\n")[0];
} finally {
  await browser.close();
}
console.log(JSON.stringify(report,null,2));
