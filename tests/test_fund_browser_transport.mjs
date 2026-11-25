import assert from "node:assert/strict";
import test from "node:test";
import { fundFromAssignments, parseDirectory, readNavAssignments } from "../web/funds/nav-source.mjs";
import { createBrowserSectorProvider, indexChartPayload, tradingWindow } from "../web/funds/sector-browser.mjs";
import { readFundText } from "../web/funds/providers.mjs";
import { fundFreshness } from "../web/funds/data.mjs";

const epoch=(date)=>Date.parse(date+"T00:00:00+08:00");
const retrievedAt=new Date("2025-01-10T00:00:00Z");

test("vendor parser keeps exact fund identity, event evidence and unresolved NAV gaps",()=>{
  const records=[
    {x:epoch("2025-01-02"),y:1.2,unitMoney:""},
    {x:epoch("2025-01-03"),y:1.14,unitMoney:"分红：每10份派现金元",equityReturn:"0.83%"},
    {x:epoch("2025-01-06"),y:.57,unitMoney:"拆分：每份折算2份",equityReturn:0},
    {x:epoch("2025-01-07"),y:.58,unitMoney:""},
    {x:epoch("2025-01-08"),y:.57,unitMoney:"分红：每10份派现金元",equityReturn:0},
    {x:epoch("2025-01-09"),y:.59,equityReturn:0},
  ];
  const payload={fS_code:"110022",fS_name:"基金;名称",Data_netWorthTrend:records,
    Data_ACWorthTrend:records.map(({x},i)=>[x,i===0?2:2.01])};
  const text=Object.entries(payload).map(([k,v])=>`var ${k} = ${JSON.stringify(v)};`).join("\n");
  const raw=readNavAssignments(text);
  assert.deepEqual(raw,payload);
  assert.throws(()=>readNavAssignments('var fS_code="110022"+"";'));
  const fund=fundFromAssignments(raw,"110022",{metadata:{category:"stock"},retrievedAt});
  assert.equal(fund.rows[1].cash_distribution,.07);
  assert.equal(fund.rows[2].split_factor,2);
  assert.ok(Math.abs(fund.rows[2].return_index-1.21/1.2)<1e-12);
  assert.equal(fund.rows[4].return_issue,"cash_after_split");
  assert.equal(fund.rows[5].return_issue,"missing_event_field");
  assert.equal(fund.rows[5].return_index,null);
  assert.throws(()=>fundFromAssignments(raw,"000001",{retrievedAt}),/不同的基金代码/);
  assert.throws(()=>fundFromAssignments({...raw,Data_netWorthTrend:[records[0],records[0]]},"110022",{retrievedAt}),/非递增/);
});

test("directory excludes exchange-traded funds but preserves linked fund categories",()=>{
  const names=parseDirectory([["110022","YFD","易方达消费行业股票","股票型","A"],
    ["510300","HS","沪深300ETF","场内","HS"],["050025","BP","标普500ETF联接A","指数型-海外股票","B"]]);
  assert.deepEqual([...names].map(([code,v])=>[code,v.category]),[["110022","stock"],["050025","qdii"]]);
});

test("stock chart lots and shared moving averages restart after an open-session gap",()=>{
  const days=["2025-01-02","2025-01-03","2025-01-06","2025-01-07","2025-01-08","2025-01-09",
    "2025-01-10","2025-01-13","2025-01-14","2025-01-15","2025-01-16","2025-01-17"];
  const history={source:{name:"测试",url:"https://example.test/"},volume:true,rows:days.filter((_,i)=>i!==5).map((date,i)=>
    ({date,close:i+10,open:i+10,high:i+10,low:i+10,volume_lots:i+100,turnover_cny:1000}))};
  const last=days.at(-1);
  const chart=indexChartPayload("110022",{code:"399997",name:"样本",index_as_of:last},{model_as_of:last},history,days);
  assert.equal(chart.volume_unit,"手");
  assert.equal(chart.rows[4].VOL5,102);
  assert.equal(chart.rows[5].volume,null);
  assert.equal(chart.rows[6].VOL5,null);
  assert.equal(chart.rows[10].VOL5,107);
});

test("calendar cutoff and explicit provider failures",async()=>{
  const calendar={schema_version:1,start:"2000-01-01",end:"2025-01-10",sessions:["2025-01-06","2025-01-07"]};
  assert.equal(tradingWindow(calendar,new Date("2025-01-07T06:59:00Z")).end,"2025-01-06");
  assert.equal(tradingWindow(calendar,new Date("2025-01-07T07:00:00Z")).end,"2025-01-07");
  await assert.rejects(readFundText("https://example.test",{fetcher:async()=>new Response(null,{status:403})}),/403/);
  await assert.rejects(readFundText("https://example.test",{fetcher:async()=>new Response("a".repeat(4_000_001))}),/超出限制/);
  const cancellation=new AbortController();
  cancellation.abort(new DOMException("deadline","TimeoutError"));
  await assert.rejects(readFundText("https://example.test",{
    signal:cancellation.signal,fetcher:async(_,options)=>options.signal.throwIfAborted(),
  }),{name:"TimeoutError"});
  assert.equal(fundFreshness({normalFrequency:true,rows:[{date:"2025-01-02"}]},"2025-01-10"),
    "净值日期已超过 7 天");
});

test("special index timeout gives later symbols a chance before a bounded retry",async()=>{
  const codes=["932133","932139","H30535"];
  const calendar={schema_version:1,start:"2000-01-01",end:"2099-01-01",sessions:["2025-01-07","2025-01-08"]};
  const indices=Object.fromEntries(codes.map((code)=>[code,{code,name:code,role:"industry",definition:"https://www.csindex.com.cn/"}]));
  const requests=[];
  const readText=async(url)=>{
    const code=url.searchParams.get("indexCode");
    requests.push(code);
    if (code===codes[0] && requests.length===1) throw new DOMException("body stalled","TimeoutError");
    return JSON.stringify({data:[{tradeDate:"20250108",indexCode:code,indexNameCnAll:code,close:10}]});
  };
  const provider=createBrowserSectorProvider(async()=>({indices}),undefined,async()=>calendar,{readText});
  const result=await provider.analyze({category:"stock",valuation_frequency:"daily",return_basis:"event_reinvested",
    rows:[{date:"2025-01-08",return_index:1}]});
  assert.deepEqual(requests,[...codes,codes[0]]);
  assert.deepEqual(result.report.special_index_diagnostics,{
    "932133":{status:"available",attempts:2,source:"csi"},
    "932139":{status:"available",attempts:1,source:"csi"},
    "H30535":{status:"available",attempts:1,source:"csi"},
  });
  assert.equal(result.report.index_coverage.available,0,"A response with insufficient history cannot enter the model.");
});
