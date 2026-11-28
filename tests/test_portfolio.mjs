import assert from "node:assert/strict";
import { test } from "node:test";
import { calculatePortfolio, normalizeTransaction } from "../worker/portfolio/ledger.mjs";
import { portfolioMarket } from "../worker/portfolio/market.mjs";
import { completeTrade } from "../worker/portfolio/ui/amounts.mjs";

const settings = [{fund_code:"123456",history_complete:true}];
const market = new Map([["123456",{source:"fixture",rows:[{date:"2026-10-11",unit_nav:"12.00"}]}]]);
function transaction(type,day,input) {
  return {...normalizeTransaction({fund_code:"123456",type,status:"confirmed",confirmed_on:day,...input}),id:day,created_at:day};
}
const buys = [
  transaction("subscription","2026-10-01",{paid_amount:"1010",fee:"10",confirmed_shares:"100",confirmed_nav:"10"}),
  transaction("subscription","2026-10-02",{paid_amount:"605",fee:"5",confirmed_shares:"50",confirmed_nav:"12"}),
];
const sale = transaction("redemption","2026-10-03",{
  confirmed_shares:"30",confirmed_nav:"13",confirmed_amount:"400",fee:"4",confirmed_amount_basis:"gross"});
const dividend = transaction("cash_dividend","2026-10-04",{received_amount:"12",received_on:"2026-10-04"});
const reinvestment = transaction("reinvestment","2026-10-05",{confirmed_amount:"25",confirmed_shares:"2",confirmed_nav:"12.5"});
const snapshot = (rows,marks=settings,quotes=market,day="2026-10-11")=>calculatePortfolio(rows,marks,quotes,day);

test("entry calculates a missing trade field with exact amounts and preserves platform values", ()=>{
  assert.deepEqual(completeTrade("subscription",{shares:"8",nav:"2.50",fee:"0.44"}),{field:"amount",value:"20.44"});
  assert.deepEqual(completeTrade("subscription",{amount:"20.44",nav:"2.50",fee:"0.44"}),{field:"shares",value:"8.000000"});
  assert.deepEqual(completeTrade("subscription",{amount:"20.44",shares:"8",fee:"0.44"}),{field:"nav",value:"2.500000"});
  assert.deepEqual(completeTrade("redemption",{shares:"8",nav:"2.50",fee:"0.44"}),{field:"amount",value:"19.56"});
  assert.deepEqual(completeTrade("redemption",{shares:"8",amount:"19.56",fee:"0.44"}),{field:"nav",value:"2.500000"});
  assert.deepEqual(completeTrade("redemption",{nav:"2.50",amount:"19.56",fee:"0.44"}),{field:"shares",value:"8.000000"});
  assert.deepEqual(completeTrade("redemption",{shares:"1",nav:"1.235",fee:"0"}),{field:"amount",value:"1.24"});
  assert.equal(completeTrade("subscription",{amount:"20.43",shares:"8",nav:"2.50",fee:"0.44"}),null);
  assert.equal(completeTrade("subscription",{amount:"20.43",fee:"0"}),null);
  assert.throws(()=>completeTrade("redemption",{shares:"1",nav:"1",fee:"1.01"}),/手续费/);
});

test("date-only entries and both confirmed conversion legs round trip without changing legacy timestamps", ()=>{
  const row=transaction("conversion","2026-10-03",{applied_at:"2026-10-01",related_fund_code:"654321",
    related_fund_name:"合成测试基金",confirmed_shares:"20",confirmed_nav:"1.25",
    related_confirmed_nav:"2.51",related_confirmed_shares:"9.95",fee:"0"});
  assert.equal(row.applied_at,"2026-10-01");
  assert.equal(row.confirmed_shares,"20.000000");
  assert.equal(row.related_confirmed_nav,"2.510000");
  assert.equal(row.related_confirmed_shares,"9.950000");
  assert.equal(snapshot([row]).funds[1].name,"合成测试基金");
  assert.equal(transaction("subscription","2026-10-03",{applied_at:"2026-10-01T08:30:15"}).applied_at,"2026-10-01 08:30:15");
  assert.throws(()=>normalizeTransaction({...row,related_fund_code:null}),/转入基金代码/);
});

test("cost, fees, cash and reinvested distributions remain separate even when transactions are backfilled", ()=>{
  const result=snapshot([sale,buys[1],dividend,reinvestment,buys[0]]);
  const fund=result.funds[0];
  for(const [key,value] of Object.entries({
    shares:"122.000000",invested:"1615.00",redeemed_net:"396.00",dividends:"12.00",holding_cost:"1317.00",
    market_value:"1464.00",realized_pnl:"110.00",floating_pnl:"147.00",total_pnl:"257.00",simple_return:"15.9133",
  })) assert.equal(fund[key],value,key);
  assert.equal(fund.redeemed_received,null);
  assert.equal(fund.cost_history[2].unit_cost,"10.766667");
  // Whole-life Modified Dietz: terminal 1464, net external 1207; weighted capital-days 12293.
  assert.equal(fund.weighted_return,"20.9062");
  assert.equal(result.totals.total_pnl,"257.00");
  assert.equal(fund.weight,"100.0000");
});

test("redeem exactly the remaining holdings, recognize net amounts once, and separate future settlement", ()=>{
  const full=transaction("redemption","2026-10-06",{confirmed_shares:"100",confirmed_amount:"1240.25",
    confirmed_amount_basis:"net",fee:"6",received_amount:"1241.25",received_on:"2026-10-12"});
  const {funds:[earlier]}=snapshot([buys[0],full]);
  assert.equal(earlier.holding_cost,"0.00");
  assert.equal(earlier.redeemed_net,"1241.25");
  assert.equal(earlier.redeemed_received,"0.00");
  assert.equal(earlier.realized_pnl,"231.25");
  const {funds:[later]}=snapshot([buys[0],full],settings,market,"2026-10-13");
  assert.equal(later.redeemed_received,"1241.25");
});

test("unclear opening history and unresolved amounts do not produce precise-looking P&L", ()=>{
  assert.equal(snapshot([buys[0]],[]).totals.market_value,null);
  const {funds:[negative]}=snapshot([{...sale,confirmed_on:"2026-09-01"},buys[0]]);
  assert.equal(negative.shares,null);
  assert.ok(negative.issues.includes("insufficient_prior_shares"));
  const {funds:[unknown]}=snapshot([buys[0],{...sale,confirmed_amount_basis:"unknown"}]);
  assert.equal(unknown.redeemed_net,null);
  assert.equal(unknown.realized_pnl,null);
  assert.equal(unknown.holding_cost,"707.00");
  assert.equal(unknown.floating_pnl,"133.00");
  const {funds:[noPayment]}=snapshot([{...buys[0],paid_amount:null,application_amount:"1010.00"}]);
  assert.equal(noPayment.invested,null);
  assert.equal(noPayment.shares,"100.000000");
  assert.equal(noPayment.holding_cost,null);
  const fromDividend=snapshot([{...dividend,confirmed_on:"2026-09-01"},buys[0]]).funds[0];
  assert.ok(fromDividend.issues.includes("unexplained_distribution"));
  assert.equal(fromDividend.total_pnl,null);
});

test("unconfirmed transactions, unsupported conversion and share splits keep their own states", ()=>{
  const pending={...sale,status:"pending",confirmed_on:null};
  assert.equal(snapshot([pending,buys[0]]).funds[0].shares,"100.000000");
  const conversion=transaction("conversion","2026-10-10",{related_fund_code:"234567",fee:"0.06"});
  const result=snapshot([conversion,buys[0]],[...settings,{fund_code:"234567",history_complete:true}]);
  assert.equal(result.funds.length,2);
  assert.ok(result.funds.every((row)=>row.issues.includes("conversion_unposted") && row.total_pnl===null));
  const split=snapshot([buys[0]],settings,new Map([["123456",{rows:[
    {date:"2026-10-09",unit_nav:"9",split_factor:2},{date:"2026-10-11",unit_nav:"9"}]}]]));
  assert.ok(split.funds[0].issues.includes("share_split"));
  assert.equal(split.funds[0].shares,null);
});

test("dated platform estimates are separate and the last confirmed market NAV does not replace transaction NAV", ()=>{
  const quotes=new Map([["123456",{rows:[{date:"2026-10-10",unit_nav:12}],estimate:{unit_nav:"12.25",updated_at:"2026-10-11 14:30:00"}}]]);
  const {funds:[fund]}=snapshot([buys[0]],settings,quotes);
  assert.equal(fund.market_value,"1200.00");
  assert.equal(fund.estimates.market_value,"1225.00");
  assert.equal(fund.estimates.pnl,"25.00");
  assert.equal(snapshot([buys[0]],settings,quotes,"2026-10-12").funds[0].estimates,null);
  assert.equal(buys[0].confirmed_nav,"10.000000");
  assert.equal(snapshot([buys[0]],settings,new Map()).funds[0].floating_pnl,null);
});

test("invalid decimal, inconsistent dates and implicit use of order fields are rejected or flagged", ()=>{
  assert.throws(()=>transaction("subscription","2026-10-01",{paid_amount:"1.0001"}),/小数/);
  assert.throws(()=>transaction("subscription","2026-02-29",{}),/日期/);
  assert.throws(()=>transaction("redemption","2026-10-02",{received_on:"2026-10-01"}),/顺序/);
  const requested=transaction("subscription","2026-10-01",{application_amount:"100",paid_amount:"100",application_shares:"10"});
  assert.ok(snapshot([requested]).funds[0].issues.includes("missing_confirmed_quantity"));
});

test("the public snapshot fallback reads only the validated fund NAV for the requested code", async (t)=>{
  const snapshot_id="ec0212bb-e5fc-4a84-b9d1-e272f186fd6a", date="2026-10-11";
  const status={schema_version:1,status:"complete",snapshot_id};
  const simulated=t.mock.method(globalThis,"fetch",async (input,options)=>{
    const url=new URL(input);
    assert.equal(options.redirect,"manual");
    if (url.hostname==="fund.eastmoney.com") return new Response(null,{status:503});
    assert.equal(url.searchParams.get("symbol"),"123456");
    if (!url.searchParams.has("snapshot_id")) return Response.json(status);
    return Response.json({...status,symbol:"123456",data_as_of:date,detail_status:"available",
      expires_at:new Date(Date.now()+60_000).toISOString(),data:{fund:{code:"123456",name:"测试",
        rows:[{date,unit_nav:12,split_factor:1,private_like_extra:true}]}}});
  });
  const result=await portfolioMarket("123456",new Request("https://portfolio.test/api/summary"),undefined,date);
  assert.equal(simulated.mock.callCount(),3);
  assert.deepEqual(result.rows,[{date,unit_nav:12,split_factor:1}]);
  assert.equal(result.estimate,undefined);
});
