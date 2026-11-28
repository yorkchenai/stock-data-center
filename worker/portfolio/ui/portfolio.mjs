import { drawCostChart } from "./chart.mjs";
import { completeTrade, decimal, redemptionNet } from "./amounts.mjs";

const $=(id)=>document.getElementById(id);
const labels={subscription:"申购",redemption:"赎回",cash_dividend:"现金分红",reinvestment:"红利再投资",conversion:"基金转换"};
const transactionStatus={pending:"待确认",confirmed:"已确认",cancelled:"已取消"};
const errors={invalid_credentials:"账号或密码不正确。",login_limited:"登录尝试过多，请稍后再试。",not_configured:"管理员登录尚未配置。",
  unauthorized:"请重新登录。",ledger_not_empty:"只有空账本才能恢复备份。",ledger_full:"账本已达记录上限，请先导出备份。",
  revision_conflict:"这笔交易已更新或删除，请重新载入后再操作。",service_unavailable:"服务暂不可用，请稍后重试。"};
const issues={history_not_verified:"完整流水尚未核实",share_split:"存在份额折算，需人工核验",
  missing_purchase_amount:"缺少实际支付金额或红利转入金额",missing_confirmed_quantity:"缺少平台确认份额",
  unresolved_redemption_amount:"赎回净额口径未核实",insufficient_prior_shares:"赎回前份额不足，缺少更早流水",
  unexplained_distribution:"分红早于首笔申购，缺少更早流水",
  missing_dividend_amount:"缺少确认分红金额",conversion_unposted:"基金转换仅记录，尚未计入持仓",
  nav_unavailable:"暂无可用确认净值",nav_before_latest_trade:"净值早于最近确认交易，盈亏暂不可计算"};
const overviewFields=[["market_value","总持仓市值"],["holding_cost","总持仓成本"],["floating_pnl","持仓浮动盈亏"],
  ["realized_pnl","已实现盈亏"],["total_pnl","累计总收益"],["estimated_pnl","今日估算盈亏"],
  ["simple_return","简单收益率"],["weighted_return","资金加权收益率"]];
const detailFields=[["holding_cost","持仓成本"],["invested","累计投入资金"],["redeemed_net","累计确认赎回净额"],
  ["redeemed_received","累计实际赎回到账"],["dividends","累计现金分红"],["realized_pnl","已实现盈亏"],
  ["floating_pnl","持仓浮动盈亏"],["total_pnl","对组合累计收益的贡献"],["contribution_share","组合收益贡献占比"]];
const monetaryFields={application_amount:"申请金额",paid_amount:"实际支付",confirmed_amount:"确认金额",fee:"手续费",received_amount:"实际到账",
  application_shares:"申请份额",confirmed_shares:"确认份额",confirmed_nav:"确认净值",confirmed_on:"确认日期",received_on:"到账日期",
  confirmed_amount_basis:"确认金额口径",applied_at:"申请日期",fund_name:"基金名称",fund_code:"基金代码",type:"交易类型",
  status:"交易状态",related_fund_code:"转入基金代码",related_fund_name:"转入基金名称",
  related_confirmed_nav:"转入确认净值",related_confirmed_shares:"转入确认份额",notes:"备注"};
const editor=$("entry");
const fields=editor.elements;
const state={ledger:{records:[],settings:[]},summary:null,detail:null,selected:null,editing:null,auth:false,refresh:0};
const calculationFields={amount:fields.amount,shares:fields.confirmed_shares,nav:fields.confirmed_nav};
let editorVersion=0, initialEntry={}, automaticField=null;
const simpleTrade=(type)=>type==="subscription" || type==="redemption";
const navFields=[
  {code:fields.fund_code,input:fields.confirmed_nav,button:$("lookup-nav"),status:$("nav-lookup-status")},
  {code:fields.related_fund_code,input:fields.related_confirmed_nav,button:$("lookup-related-nav"),status:$("related-nav-lookup-status")},
];
const fmt=(value,suffix="")=>{
  if (value == null) return "—";
  const [whole, fraction]=String(value).split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g,",")+(fraction ? "."+fraction : "")+suffix;
};
const text=(tag,value,className)=>{
  const node=document.createElement(tag);
  if(className) node.className=className;
  node.textContent=value??"";
  return node;
};
function button(label,action){
  const node=text("button",label,"link"); node.type="button"; node.addEventListener("click",action); return node;
}
function notice(message){ $("notice").textContent=message; }

async function api(path,{method="GET",body,signal}={}){
  const res=await fetch("/api/"+path,{method,cache:"no-store",signal,
    ...(body===undefined?{}:{headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});
  const data=await res.json();
  if(!res.ok){
    if(res.status===401 && path!=="login") signedOut();
    throw new Error(data.message??errors[data.error]??"请求失败。");
  }
  return data;
}
function signedOut(){
  state.auth=false; state.refresh++; state.selected=null; state.editing=null; state.summary=null; state.detail=null;
  state.ledger={records:[],settings:[]};
  $("account").hidden=$("toolbar").hidden=$("logout").hidden=true;
  $("login-panel").hidden=false;
  $("as-of").textContent="";
  $("detail").hidden=true;
  $("editor").close(); $("audit").close(); editor.reset(); $("restore").reset();
  for(const id of ["metrics","holdings-info","detail-metrics","quote","fund-issues","fund-title","chart-note","audit-records"])
    $(id).replaceChildren();
  for(const id of ["records","fund-records","holdings"]) $(id).tBodies[0].replaceChildren();
  $("cost-chart").width=$("cost-chart").width;
}
function signedIn(){
  state.auth=true;
  $("login-panel").hidden=true;
  $("account").hidden=$("toolbar").hidden=$("logout").hidden=false;
}
function metric(label,value,percent,signed){
  const article=document.createElement("article");
  const amount=text("strong",fmt(value,percent?"%":" 元"),"metric-value");
  if(signed && value!==null && Number(value)!==0) amount.dataset.tone=Number(value)>0?"positive":"negative";
  article.append(text("div",label,"metric-label"),amount);
  return article;
}
function metricList(id,fields,values){
  $(id).replaceChildren(...fields.map(([key,label])=>metric(label,values?.[key]??null,
    key.endsWith("return")||key==="contribution_share",key.includes("pnl")||key.endsWith("return"))));
}
function addCell(row,value,secondary){
  const cell=row.insertCell();
  if(secondary!==undefined) cell.append(text("strong",value),text("small",secondary));
  else cell.textContent=value;
  return cell;
}
function emptyRow(body,label){
  const cell=body.insertRow().insertCell(); cell.colSpan=body.previousElementSibling.rows[0].cells.length; cell.textContent=label;
}
function renderPositions(){
  metricList("metrics",overviewFields,state.summary?.totals);
  const body=$("holdings").tBodies[0]; body.replaceChildren();
  const funds=state.summary?.funds??[];
  if(!funds.length) emptyRow(body,state.summary?"暂无基金交易。":"正在读取确认净值…");
  for(const fund of funds){
    const row=body.insertRow();
    const name=row.insertCell();
    name.append(button(fund.name,()=>openDetail(fund.code)),text("small",fund.issues.length?fund.code+" · 数据待核实":fund.code));
    addCell(row,fmt(fund.shares));
    addCell(row,fmt(fund.market_value," 元"),fmt(fund.weight,"%"));
    addCell(row,fmt(fund.holding_cost," 元"));
    addCell(row,fmt(fund.floating_pnl," 元"));
    addCell(row,fmt(fund.nav?.unit_nav),fund.nav?.date??"暂无确认净值");
  }
  const info=$("holdings-info"); info.replaceChildren();
  if(state.summary){
    $("as-of").textContent="核算日 "+state.summary.as_of+"（北京时间）";
    const total=state.summary.totals;
    if(total.estimated_pnl===null) info.append(text("p","暂无可靠估值。组合估算需要全部在持基金有可用估值。","note"));
    if(funds.some((fund)=>fund.issues.length)) info.append(text("p","缺少完整流水或确认行情时，相关数值以 — 显示。","note"));
    if(total.cashflow_dates_estimated) info.append(text("p","部分实际现金流日期缺失，资金加权收益率用记账日期近似。","note"));
    info.append(text("p","简单收益率以累计总收益除以累计实际投入。资金加权收益率采用修正 Dietz，按资金在场时间加权。","note"));
  }
}
function sorted(records){
  return [...records].sort((a,b)=>(b.applied_at??b.confirmed_on??b.created_at).localeCompare(a.applied_at??a.confirmed_on??a.created_at));
}
function entryAmount(txn){
  if (txn.type==="subscription") return txn.paid_amount;
  if (txn.type==="redemption") return decimal(redemptionNet(txn),2);
  return txn.received_amount??txn.confirmed_amount;
}
function renderRecords(id,records){
  const body=$(id).tBodies[0]; body.replaceChildren();
  if(!records.length) emptyRow(body,"暂无交易。");
  for(const txn of sorted(records)){
    const row=body.insertRow();
    addCell(row,txn.applied_at?.slice(0,10)??txn.confirmed_on??"—");
    const description = txn.type==="conversion" && txn.related_fund_code
      ? `转入 ${txn.related_fund_name??txn.related_fund_code}` : labels[txn.type];
    const detail = txn.status==="confirmed" ? description : description+" · "+transactionStatus[txn.status];
    addCell(row,id==="records"?(txn.fund_name??txn.fund_code):labels[txn.type],detail);
    addCell(row,fmt(txn.confirmed_shares));
    addCell(row,fmt(entryAmount(txn)," 元"),
      txn.fee===null?"":("手续费 "+fmt(txn.fee," 元")));
    const actions=row.insertCell();
    actions.append(button("查看 / 编辑",()=>openEditor(txn)),button("修改记录",()=>showAudit(txn)),button("删除",()=>deleteRecord(txn)));
  }
}
function renderLedger(){
  const filter=$("filter-fund"), prior=filter.value;
  filter.replaceChildren(new Option("全部基金",""));
  for(const [code,name] of new Map(state.ledger.records.map((txn)=>[txn.fund_code,txn.fund_name??txn.fund_code]))){
    filter.add(new Option(name===code?code:name+" · "+code,code));
  }
  filter.value=[...filter.options].some((option)=>option.value===prior)?prior:"";
  renderRecords("records",state.ledger.records.filter((txn)=>!filter.value||txn.fund_code===filter.value));
}
function redraw(){
  if(!state.detail) return;
  const {fund,history}=state.detail;
  const points=drawCostChart($("cost-chart"),history,fund.cost_history,Number($("chart-range").value));
  $("chart-note").textContent= !points ? "暂无可绘制数据。" :
    (fund.cost_history.length ? "成本在平台确认日更新。净值使用未复权确认单位净值。" : "暂无可核实的个人成本线。");
}
function renderDetail(){
  const {fund,history,transactions}=state.detail;
  $("fund-title").textContent=fund.name+" · "+fund.code;
  $("fund-issues").textContent=fund.issues.map((issue)=>issues[issue]).filter(Boolean).join(" · ");
  metricList("detail-metrics",detailFields,fund);
  const settings=$("quote"); settings.replaceChildren();
  const label=text("label","");
  const verify=document.createElement("input"); verify.type="checkbox"; verify.checked=fund.history_complete;
  verify.addEventListener("change",async()=>{
    verify.disabled=true;
    try {
      await api("settings/"+fund.code,{method:"PUT",body:{history_complete:verify.checked}});
      await refresh();
    }catch(error){verify.checked=!verify.checked;notice(error.message);}
    finally{verify.disabled=false;}
  });
  label.className="inline";
  label.append(verify,document.createTextNode("已核实。这只基金从首次持有起的流水已完整录入"));
  settings.append(label);
  if(fund.nav) settings.append(text("p","最新确认净值 "+fmt(fund.nav.unit_nav)+" · "+fund.nav.date+" · "+fund.nav.source));
  const estimate=fund.estimates;
  if(estimate) {
    settings.append(text("p","当日参考估值 "+fmt(estimate.unit_nav)+" · "+fmt(estimate.change_pct,"%")+" · 估算市值 "+
      fmt(estimate.market_value," 元")+" · 估算盈亏 "+fmt(estimate.pnl," 元")));
    settings.append(text("p",estimate.source+" · "+estimate.updated_at+"（北京时间） · "+estimate.confidence));
  }else settings.append(text("p","暂无可靠估值"));
  $("detail").hidden=false;
  renderRecords("fund-records",transactions);
  redraw();
  if(!history.length) $("chart-note").textContent="确认净值暂不可用。"+(fund.cost_history.length?"个人成本线仍可查看。":"");
}
async function loadDetail(code,scroll){
  const detail=await api("funds/"+code);
  if(!state.auth||state.selected!==code) return;
  const contribution=state.summary?.funds.find((fund)=>fund.code===code)?.contribution_share;
  detail.fund.contribution_share=contribution??null;
  state.detail=detail;
  renderDetail();
  if(scroll) $("detail").scrollIntoView({block:"start"});
}
async function openDetail(code){
  state.selected=code;
  try {await loadDetail(code,true);} catch(error){notice(error.message);}
}
async function refresh(){
  if(!state.auth) return;
  const request=++state.refresh;
  const ledger=await api("ledger");
  if(request!==state.refresh) return;
  state.ledger=ledger;renderLedger();
  const summary=await api("summary");
  if(request!==state.refresh) return;
  state.summary=summary;renderPositions();
  if(state.selected) await loadDetail(state.selected,false);
}
function syncEditor(){
  const type=fields.type.value;
  const conversion=type==="conversion", quantity=conversion || simpleTrade(type) || type==="reinvestment";
  for(const group of editor.querySelectorAll("[data-for]")){
    const visible=group.dataset.for.split(" ").includes(type);
    group.hidden=!visible;
    for(const control of group.querySelectorAll("input,button")) control.disabled=!visible;
  }
  $("fund-code-label").textContent=conversion?"转出基金代码":"基金代码";
  $("fund-name-label").textContent=conversion?"转出基金名称":"基金名称";
  $("shares-label").textContent=conversion?"转出确认份额":"确认份额";
  $("nav-label").textContent=conversion?"转出确认净值":"确认单位净值";
  $("amount-label").textContent={
    subscription:"申请金额（含费，元）",redemption:"赎回净额（扣费后，元）",
    cash_dividend:"现金分红净额（元）",reinvestment:"红利转入金额（元）",
  }[type]??"金额（元）";
  fields.fee.setCustomValidity("");
  fields.confirmed_shares.required=fields.confirmed_nav.required=quantity;
  fields.fee.required=conversion || simpleTrade(type);
  fields.amount.required=!conversion;
  for(const key of ["related_fund_code","related_confirmed_nav","related_confirmed_shares"])
    fields[key].required=conversion;
  $("type-hint").textContent={
    subscription:"金额＝份额 × 净值＋手续费。填手续费和另两项即可试算，平台有确认值时请填原值。",
    redemption:"净额＝份额 × 净值－手续费。填手续费和另两项即可试算，平台有确认值时请填原值。",
    cash_dividend:"填写现金分红净额，按申请日期记录现金流。",
    reinvestment:"填写转为持仓成本的红利金额和平台确认份额。",
    conversion:"按平台填写两边的确认净值和份额。转换目前仅记录，尚未计入持仓。",
  }[type];
}
function recalculate(edited){
  if (!simpleTrade(fields.type.value)) return;
  if (automaticField && edited!==automaticField) calculationFields[automaticField].value="";
  automaticField=null;
  const note=$("calculation-status");
  note.hidden=true;
  fields.fee.setCustomValidity("");
  try {
    const values=Object.fromEntries(Object.entries(calculationFields).map(([key,input])=>[key,input.value.trim()]));
    const result=completeTrade(fields.type.value,{...values,fee:fields.fee.value.trim()});
    if (result) {
      automaticField=result.field;
      calculationFields[result.field].value=result.value;
      note.textContent=`已试算${{amount:"金额",shares:"份额",nav:"净值"}[result.field]}，保存前可按平台原值调整。`;
      note.hidden=false;
    }
  } catch(error) {
    fields.fee.setCustomValidity(error.message);
    note.textContent=error.message;
    note.hidden=false;
  }
}
function resetNavLookup(field, clearValue=false){
  field.request?.abort();
  field.offer=null;
  field.button.hidden=true;
  field.status.textContent="";
  if (clearValue && field.adopted) {
    field.input.value="";
    field.adopted=false;
    if (field.input===fields.confirmed_nav) recalculate();
  }
}
async function lookupNav(field){
  const code=field.code.value,date=fields.applied_at.value;
  const hasNav=field.input.value && !(field.input===fields.confirmed_nav && automaticField==="nav");
  if (field.input.disabled || hasNav || !/^\d{6}$/.test(code) || !date) return;
  const request=new AbortController();
  field.request=request;
  const prefix=fields.type.value!=="conversion"?"":field.input===fields.confirmed_nav?"转出 · ":"转入 · ";
  field.status.textContent=prefix+"正在查询申请日净值…";
  try {
    const quote=await api(`fund-entry/${code}?date=${date}`,{signal:request.signal});
    if (request.signal.aborted || !$("editor").open) return;
    if (quote.unit_nav) {
      field.offer=quote;
      field.button.hidden=false;
      field.status.textContent=`${prefix}${quote.date} · ${quote.unit_nav} · ${quote.source}。请与平台成交净值核对。`;
    } else field.status.textContent=prefix+"申请日暂无净值，请填写平台原值。";
  } catch {
    if (!request.signal.aborted && $("editor").open) field.status.textContent=prefix+"暂未查到净值，可手动填写。";
  } finally {
    if (field.request===request) field.request=null;
  }
}
function refreshNavLookups(){
  for (const field of navFields) {
    resetNavLookup(field,true);
    void lookupNav(field);
  }
}
async function lookupName(codeField,nameField){
  const input=fields[codeField],name=fields[nameField],code=input.value,version=editorVersion;
  name.value="";
  if (!/^\d{6}$/.test(code)) return;
  const found=state.ledger.records.findLast((txn)=>txn.fund_code===code && txn.fund_name);
  if (found) {
    name.value=found.fund_name;
    return;
  }
  name.placeholder="正在查询…";
  const isCurrent=()=>version===editorVersion && $("editor").open && input.value===code;
  try {
    const result=await api("fund-entry/"+code);
    if (isCurrent() && !name.value) name.value=result.name??"";
  } catch { /* The user can enter a name when the directory is unavailable. */ }
  finally { if (isCurrent()) name.placeholder=name.value?"":"未查到，可手动填写"; }
}
function formValues(){
  return Object.fromEntries(new FormData(editor));
}
function transactionInput(entry){
  const previous=state.editing?.type===entry.type?state.editing:null;
  const changed=(field)=>!previous || entry[field]!==initialEntry[field];
  const data={...previous,fund_code:entry.fund_code,fund_name:entry.fund_name,type:entry.type,
    status:state.editing?.status??"confirmed",notes:entry.notes};
  if (changed("applied_at")) {
    data.applied_at=entry.applied_at;
    if (!previous?.confirmed_on || previous.confirmed_on===previous.applied_at?.slice(0,10))
      data.confirmed_on=entry.applied_at;
  }
  for (const key of ["confirmed_shares","confirmed_nav","fee","related_fund_code",
    "related_fund_name","related_confirmed_nav","related_confirmed_shares"]) {
    if (key in entry && changed(key)) data[key]=entry[key];
  }
  if (entry.type==="subscription" && changed("amount")) {
    data.application_amount=entry.amount;
    data.paid_amount=entry.amount;
  } else if (entry.type==="redemption" && changed("amount")) {
    data.confirmed_amount=entry.amount;
    data.confirmed_amount_basis="net";
    const hasActualAmount=automaticField!=="amount" && previous?.received_amount!=null;
    data.received_amount=hasActualAmount ? entry.amount : null;
  } else if (["cash_dividend","reinvestment"].includes(entry.type) && changed("amount")) {
    data.confirmed_amount=entry.amount;
    if (previous?.received_amount!=null) data.received_amount=entry.amount;
  }
  return data;
}
function openEditor(txn){
  editorVersion++;
  editor.reset();state.editing=txn??null;automaticField=null;
  for (const field of navFields) {
    field.adopted=false;
    resetNavLookup(field);
  }
  $("calculation-status").hidden=true;
  $("editor-title").textContent=txn?"查看 / 编辑交易":"录入交易";
  $("editor-status").textContent="";
  if(txn) for(const control of editor.elements){
    const value=txn[control.name];
    if(value!=null) control.value=control.name==="applied_at"?value.slice(0,10):value;
  }
  fields.amount.value=txn?entryAmount(txn)??"":"";
  fields.applied_at.value ||= txn?.confirmed_on??(!txn?state.summary?.as_of??"":"");
  fields.fund_name.placeholder=fields.related_fund_name.placeholder="输入代码后自动查询";
  syncEditor();
  initialEntry=formValues();
  $("editor").showModal();
  for (const field of navFields) void lookupNav(field);
}
async function deleteRecord(txn){
  if(!confirm("删除这笔"+labels[txn.type]+"记录？修改记录会保留。")) return;
  try{
    await api("transactions/"+txn.id,{method:"DELETE",body:{revision:txn.revision}});
    notice("交易已删除，修改记录已保留。");
    await showAudit(txn);
    if(state.selected && !state.ledger.records.some((row)=>row.id!==txn.id && (row.fund_code===state.selected||row.related_fund_code===state.selected))) {
      state.selected=null;state.detail=null;$("detail").hidden=true;
    }
    await refresh();
  }catch(error){notice(error.message);}
}
async function showAudit(txn){
  try{
    const {audit}=await api("transactions/"+txn.id+"/audit");
    const records=$("audit-records"); records.replaceChildren();
    for(const entry of [...audit].reverse()){
      const item=text("div","","audit-item");
      const when=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",dateStyle:"short",timeStyle:"medium"}).format(new Date(entry.occurred_at));
      item.append(text("strong",({create:"创建",edit:"编辑",delete:"删除"})[entry.action]+" · "+when+"（北京时间）"));
      const details=document.createElement("dl");
      for(const [key,label] of Object.entries(monetaryFields)){
        const before=entry.before?.[key], after=entry.after?.[key];
        if(before!==after && (before!=null||after!=null)){
          const display=(value)=>({type:labels,status:transactionStatus,confirmed_amount_basis:{net:"扣费后净额",gross:"扣费前总额",unknown:"未核实"}}[key]?.[value]??value??"—");
          details.append(text("dt",label),text("dd",entry.action==="edit"?display(before)+" → "+display(after):display(after??before)));
        }
      }
      item.append(details);records.append(item);
    }
    if(!$("audit").open) $("audit").showModal();
  }catch(error){notice(error.message);}
}

$("login").addEventListener("submit",async(event)=>{
  event.preventDefault();notice("");
  const form=event.currentTarget, submit=form.querySelector("button");
  submit.disabled=true;
  try{
    await api("login",{method:"POST",body:Object.fromEntries(new FormData(form))});
    form.reset();signedIn();await refresh();
  }catch(error){notice(error.message);form.elements.password.value="";}
  finally{submit.disabled=false;}
});
$("logout").addEventListener("click",async()=>{
  try{await api("logout",{method:"POST"});signedOut();notice("");}catch(error){notice(error.message);}
});
$("reload").addEventListener("click",async(event)=>{
  const node=event.currentTarget;node.disabled=true;notice("");
  try{await refresh();}catch(error){notice(error.message);}finally{node.disabled=false;}
});
$("add").addEventListener("click",()=>openEditor());
$("close-editor").addEventListener("click",()=>$("editor").close());
$("close-detail").addEventListener("click",()=>{state.selected=null;state.detail=null;$("detail").hidden=true;});
$("close-audit").addEventListener("click",()=>$("audit").close());
$("filter-fund").addEventListener("change",renderLedger);
$("chart-range").addEventListener("change",redraw);
new ResizeObserver(redraw).observe($("cost-chart"));
fields.type.addEventListener("change",()=>{
  if (automaticField) calculationFields[automaticField].value="";
  automaticField=null;
  fields.amount.value="";
  syncEditor();refreshNavLookups();
  $("calculation-status").hidden=true;
});
fields.applied_at.addEventListener("change",refreshNavLookups);
fields.fee.addEventListener("input",()=>recalculate("fee"));
calculationFields.amount.addEventListener("input",()=>recalculate("amount"));
calculationFields.shares.addEventListener("input",()=>recalculate("shares"));
for (const field of navFields) {
  field.code.addEventListener("input",()=>{
    resetNavLookup(field,true);
    void lookupName(field.code.name,field.code===fields.fund_code?"fund_name":"related_fund_name");
    void lookupNav(field);
  });
  field.input.addEventListener("input",()=>{
    field.adopted=false;
    resetNavLookup(field);
    if (field.input===fields.confirmed_nav) recalculate("nav");
    void lookupNav(field);
  });
  field.button.addEventListener("click",()=>{
    const quote=field.offer;
    if (!quote) return;
    resetNavLookup(field);
    field.input.value=quote.unit_nav;
    field.adopted=true;
    field.status.textContent=`已带入 ${quote.date} 净值，可按平台原值修改。`;
    if (field.input===fields.confirmed_nav) recalculate("nav");
  });
}
$("editor").addEventListener("close",()=>{
  if (!$("editor").open) for (const field of navFields) resetNavLookup(field);
});
editor.addEventListener("submit",async(event)=>{
  event.preventDefault();
  const submit=editor.querySelector("[type=submit]"), editing=state.editing;
  const transaction=transactionInput(formValues());
  submit.disabled=true;$("editor-status").textContent="";
  try{
    if(editing) await api("transactions/"+editing.id,{method:"PUT",body:{transaction,revision:editing.revision}});
    else await api("transactions",{method:"POST",body:transaction});
    $("editor").close();editor.reset();notice("交易已保存。");
    await refresh();
  }catch(error){ if($("editor").open) $("editor-status").textContent=error.message;else notice(error.message); }
  finally{submit.disabled=false;}
});
$("restore").addEventListener("submit",async(event)=>{
  event.preventDefault();
  const file=$("backup-file").files[0], submit=event.currentTarget.querySelector("button");
  if(!file||file.size>4_000_000){notice("请选择小于 4 MB 的 JSON 备份。");return;}
  if(!confirm("将备份恢复到当前空账本？")) return;
  submit.disabled=true;
  try{await api("restore",{method:"POST",body:JSON.parse(await file.text())});$("restore").reset();notice("备份已恢复。");await refresh();}
  catch(error){notice(error instanceof SyntaxError?"备份文件不是有效 JSON。":error.message);}
  finally{submit.disabled=false;}
});

try {await api("session");signedIn();await refresh();}
catch(error){if(state.auth)notice(error.message);else signedOut();}
