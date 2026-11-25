// Summary used by a private MCP host. No daily history is sent as tool output.
import { FUND_CODE, fundFreshness, normalizeFund } from "./data.mjs";
import { analyzePerformance, periodReturn, periodStart, selectWindow } from "./performance.mjs";

export async function fundRadar(args,{loadFund,loadSector}) {
  const code=args?.symbol;
  if (typeof code!=="string"||!FUND_CODE.test(code)||Object.keys(args).length!==1) {
    return {schema_version:1,status:"invalid_arguments",message:"请输入六位场外基金代码。"};
  }
  try {
    const fund=normalizeFund(await loadFund(code));
    if (fund.code!==code) throw new Error("行情源返回了不同的基金代码。");
    const latest=fund.rows.at(-1);
    const interval=selectWindow(fund,periodStart(latest.date,"1y"),latest.date);
    const drawdown=analyzePerformance(fund,interval).metrics.drawdown;
    let model,modelFailure;
    try {model=(await loadSector(fund)).report;}
    catch (error) {modelFailure=error.message;}
    return {schema_version:1,status:model?.status==="ok"?"ok":"partial",symbol:code,name:fund.name,category:fund.category,
      source:fund.source,last_confirmed_nav_date:latest.date,latest_nav:latest.unit_nav,freshness:fundFreshness(fund),
      returns:Object.fromEntries(["1m","3m","1y"].map((period)=>[period,periodReturn(fund,period)])),
      max_drawdown:{...drawdown,start:interval.start??null,end:interval.end??null},
      sector_status:model?.status??"indices_unavailable",sector_message:modelFailure??null,
      sector_model_as_of:model?.model_as_of??null,index_coverage:model?.index_coverage??null,
      sectors:(model?.sectors??[]).map((sector)=>({code:sector.code,name:sector.name,rank:sector.rank,beta:sector.beta,
        stability:sector.stability,last_index_trade_date:sector.index_as_of}))};
  } catch (error) {
    return {schema_version:1,status:"data_unavailable",symbol:code,message:error.message};
  }
}
