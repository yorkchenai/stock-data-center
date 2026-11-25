// Browser counterpart to stock_analysis/sector_model.py. Dates are explicit exchange sessions.
const FUND="__fund__";
const WINDOWS=[20,60,120];
const METHODS=["ols","ridge","elastic_net"];
const mean=(values)=>values.reduce((sum,v)=>sum+v,0)/values.length;
const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const deviation=(values)=>{
  const center=mean(values);
  return Math.sqrt(mean(values.map((v)=>(v-center)**2)));
};
const positive=(v)=>Number.isFinite(v)&&v>0;
const transpose=(rows)=>rows[0].map((_,i)=>rows.map((row)=>row[i]));

export function alignSectorReturns(fund,histories,sessions) {
  if (fund.valuation_frequency!=="daily" || !["stock","mixed","index"].includes(fund.category)) {
    throw new Error("unsupported_fund_frequency_or_type");
  }
  if (!["event_reinvested","adjusted_nav"].includes(fund.return_basis)) throw new Error("unsupported_total_return_basis");
  const sessionSet=new Set(sessions), levels=new Map(), seen=new Set(), unresolved=new Set();
  for (const row of fund.rows) {
    if (seen.has(row.date)) throw new Error("Duplicate fund valuation dates");
    seen.add(row.date);
    if (row.date<sessions[0] || row.date>sessions.at(-1)) continue;
    if (sessionSet.has(row.date)) levels.set(row.date,row.return_issue?null:row.return_index);
    else if (row.return_issue || row.return_index===null) unresolved.add(sessions.find((day)=>day>row.date));
  }
  for (const day of unresolved) levels.set(day,null);
  const all={[FUND]:levels};
  for (const [code,rows] of Object.entries(histories)) {
    const series=new Map();
    for (const row of rows) {
      if (series.has(row.date) || !sessionSet.has(row.date)) throw new Error("Observations outside or duplicated in the session calendar");
      series.set(row.date,row.close);
    }
    all[code]=series;
  }
  return sessions.map((date,i)=>({date,...Object.fromEntries(Object.entries(all).map(([code,series])=>{
    const current=series.get(date), prior=series.get(sessions[i-1]);
    return [code,positive(current)&&positive(prior)?current/prior-1:null];
  }))}));
}

function corr(a,b) {
  const spreadA=deviation(a),spreadB=deviation(b);
  if (Math.min(spreadA,spreadB)<1e-10) return null;
  const ma=mean(a),mb=mean(b);
  return Math.max(-1,Math.min(1,mean(a.map((v,i)=>(v-ma)*(b[i]-mb)))/(spreadA*spreadB)));
}

function leastSquares(rows,y) {
  // One-sided Jacobi SVD with the same rank cutoff as numpy.linalg.lstsq.
  const columns=transpose(rows), k=columns.length;
  const transform=Array.from({length:k},(_,i)=>Array.from({length:k},(_,j)=>Number(i===j)));
  const rotate=(a,b,c,s)=>{
    for(let i=0;i<a.length;i++) {
      const x=a[i],v=b[i];
      a[i]=c*x-s*v;
      b[i]=s*x+c*v;
    }
  };
  for(let sweep=0;sweep<60;sweep++){
    let changed=false;
    for(let i=0;i<k;i++) for(let j=i+1;j<k;j++){
      const a=columns[i],b=columns[j], aa=dot(a,a),bb=dot(b,b),ab=dot(a,b);
      if (Math.abs(ab)<=Number.EPSILON*Math.sqrt(aa*bb)*2) continue;
      const tau=(bb-aa)/(2*ab);
      const t=(tau<0?-1:1)/(Math.abs(tau)+Math.hypot(1,tau));
      const c=1/Math.hypot(1,t),s=t*c;
      rotate(a,b,c,s);
      rotate(transform[i],transform[j],c,s);
      changed=true;
    }
    if (!changed) break;
  }
  const singular=columns.map((column)=>Math.sqrt(dot(column,column)));
  const largest=Math.max(...singular),smallest=Math.min(...singular);
  const tolerance=largest*Math.max(rows.length,k)*Number.EPSILON;
  const coefficients=Array(k).fill(0);
  let rank=0;
  for(let i=0;i<k;i++) {
    if (singular[i]<=tolerance) continue;
    rank++;
    if (y) {
      const projection=dot(columns[i],y)/(singular[i]**2);
      for(let j=0;j<k;j++) coefficients[j]+=projection*transform[i][j];
    }
  }
  return {coefficients,rank,condition:smallest>0?largest/smallest:null};
}

const values=(rows,key)=>rows.map((row)=>row[key]);
const design=(rows,keys)=>rows.map((row)=>keys.map((key)=>row[key]));
const observed=(rows,keys)=>rows.filter((row)=>keys.every((key)=>Number.isFinite(row[key])));
function windowOf(rows, keys, size) {
  const recent=rows.slice(-Math.ceil(size*1.25));
  const complete=observed(recent,keys);
  return {block:complete.slice(-size),gaps:recent.length-complete.length};
}
function residuals(y,x) {
  const coefficients=leastSquares(x,y).coefficients;
  return y.map((v,i)=>v-dot(x[i],coefficients));
}

function correlations(rows,sector,markets,size) {
  const {block:pair,gaps:pairGaps}=windowOf(rows,[FUND,sector],size);
  const {block:common,gaps:commonGaps}=windowOf(rows,[FUND,sector,...markets],size);
  const x=design(common,markets).map((columns)=>[1,...columns]);
  const valid=markets.length&&common.length===size&&leastSquares(x).rank===markets.length+1;
  return {
    count:pair.length,first:pair[0]?.date??null,last:pair.at(-1)?.date??null,missing_in_lookback:pairGaps,
    pearson:pair.length===size?corr(values(pair,FUND),values(pair,sector)):null,
    partial_count:common.length,partial_missing_in_lookback:commonGaps,partial_first:common[0]?.date??null,
    partial_last:common.at(-1)?.date??null,
    partial:valid?corr(residuals(values(common,FUND),x),residuals(values(common,sector),x)):null,
  };
}
function redundancy(order,rows,markets) {
  const chosen=[];
  for (const code of order) {
    const redundant=chosen.some((prior)=>{
      const common=observed(rows.slice(-150),[code,prior,...markets]);
      if (common.length<60) return false;
      const x=design(common,markets).map((sample)=>[1,...sample]);
      const strength=corr(residuals(values(common,code),x),residuals(values(common,prior),x));
      return strength!==null&&Math.abs(strength)>=.90;
    });
    if (!redundant) chosen.push(code);
  }
  return chosen;
}
function solveRidge(columns,y) {
  const n=y.length,k=columns.length;
  const matrix=columns.map((a,i)=>[...columns.map((b,j)=>dot(a,b)/n+(i===j ? .10 : 0)),dot(a,y)/n]);
  for(let i=0;i<k;i++) {
    const pivot=matrix[i][i];
    for(let j=i;j<=k;j++) matrix[i][j]/=pivot;
    for(let row=i+1;row<k;row++){
      const factor=matrix[row][i];
      for(let col=i;col<=k;col++) matrix[row][col]-=factor*matrix[i][col];
    }
  }
  const out=Array(k).fill(0);
  for(let i=k-1;i>=0;i--) out[i]=matrix[i][k]-dot(matrix[i].slice(i+1,k),out.slice(i+1));
  return out;
}

function elastic(columns,y) {
  const beta=Array(columns.length).fill(0),residual=y.slice();
  const squares=columns.map((column)=>dot(column,column)/y.length);
  for(let iteration=0;iteration<3000;iteration++) {
    let maxChange=0;
    for(const [i,column] of columns.entries()){
      for(let row=0;row<y.length;row++) residual[row]+=beta[i]*column[row];
      const score=dot(residual,column)/y.length;
      const value=Math.sign(score)*Math.max(Math.abs(score)-.05,0)/(squares[i]+.05);
      for(let row=0;row<y.length;row++) residual[row]-=value*column[row];
      maxChange=Math.max(maxChange,Math.abs(value-beta[i]));
      beta[i]=value;
    }
    if (maxChange<1e-8) return beta;
  }
  throw new Error("elastic_net_did_not_converge");
}

function fit(method,x,y) {
  if (x.length<x[0].length+2) throw new Error("insufficient_regression_sample");
  const columns=transpose(x);
  const means=columns.map(mean), spreads=columns.map((column)=>deviation(column)).map((v)=>v>1e-12?v:1);
  const standardized=columns.map((column,i)=>column.map((v)=>(v-means[i])/spreads[i]));
  const central=mean(y),centered=y.map((v)=>v-central);
  const least=leastSquares(transpose(standardized),method==="ols"?centered:null);
  const scale=Math.max(1e-12,deviation(y));
  const normalized=method==="ols"?least.coefficients:method==="ridge"?solveRidge(standardized,centered):
    elastic(standardized,centered.map((v)=>v/scale)).map((v)=>v*scale);
  const slopes=normalized.map((value,i)=>value/spreads[i]);
  return {slopes,intercept:central-dot(means,slopes),condition:least.condition};
}
function exposure(rows,candidates,markets) {
  const keys=[...markets,...candidates];
  const recent=windowOf(rows,[FUND,...keys],120).block;
  if (recent.length!==120) return {};
  const x=design(recent,keys),y=values(recent,FUND);
  return Object.fromEntries(METHODS.map((method)=>{
    const {slopes,intercept,condition}=fit(method,x,y);
    const rolled=[];
    for (const offset of [40,20,0]) {
      const sample=offset?rows.slice(0,-offset):rows;
      const block=windowOf(sample,[FUND,...keys],100).block;
      if (block.length===100) rolled.push(fit(method,design(block,keys),values(block,FUND)).slopes);
    }
    const columns=rolled.length?transpose(rolled):[];
    const errors=y.map((v,i)=>v-intercept-dot(x[i],slopes));
    const total=y.length*deviation(y)**2;
    return [method,{n:recent.length,first:recent[0].date,last:recent.at(-1).date,condition,intercept,
      in_sample_r2:total>1e-15?1-dot(errors,errors)/total:null,
      residual_daily_std:deviation(errors)*Math.sqrt(y.length/(y.length-1)),
      betas:Object.fromEntries(keys.map((key,i)=>[key,slopes[i]])),
      positive_fraction:Object.fromEntries(columns.map((col,i)=>[keys[i],mean(col.map((v)=>Number(v>0)))])),
      beta_range:Object.fromEntries(columns.map((col,i)=>[keys[i],[Math.min(...col),Math.max(...col)]])),
      stability_windows:rolled.length}];
  }));
}

export function rankAssociations(input,candidates,markets,holdings={}) {
  const last=input.findLastIndex((row)=>Number.isFinite(row[FUND]));
  const rows=input.slice(0,last+1);
  if (rows.length<120||!markets.length||candidates.length<3) {
    return {status:"insufficient_coverage",ranked:[],profiles:{},models:{}};
  }
  const profiles=Object.fromEntries(candidates.map((code)=>[code,{windows:Object.fromEntries(
    WINDOWS.map((size)=>[size,correlations(rows,code,markets,size)]))}]));
  for (const profile of Object.values(profiles)) {
    const short=profile.windows[60],long=profile.windows[120];
    if (short.partial>=.10&&long.partial>=.10&&short.pearson>=.30&&long.pearson>=.30&&short.partial_last===rows.at(-1).date) {
      profile.score=.35*short.partial+.35*long.partial+.15*short.pearson+.15*long.pearson;
    }
  }
  const order=candidates.filter((code)=>Number.isFinite(profiles[code].score))
    .sort((a,b)=>profiles[b].score-profiles[a].score||a.localeCompare(b,"en"));
  const shortlisted=redundancy(order,rows,markets).slice(0,8);
  const models=exposure(rows,shortlisted,markets),ridge=models.ridge;
  const ranked=[];
  for (const code of shortlisted) {
    const beta=ridge?.betas[code],stability=ridge?.positive_fraction[code];
    if (beta===undefined||beta<.05||stability===undefined||stability<2/3||ridge.stability_windows<2) continue;
    const evidence=holdings[code]??null,profile=profiles[code];
    ranked.push({code,beta,positive_fraction:stability,beta_range:ridge.beta_range[code],windows:profile.windows,
      holdings_evidence:evidence,quality:stability===1&&profile.windows[120].partial>=.25?"strong":"moderate",
      score:profile.score+(evidence?.supportible ? .02 : 0)});
  }
  ranked.sort((a,b)=>b.score-a.score||a.code.localeCompare(b.code,"en"));
  return {status:ranked.length?"ok":"no_reliable_association",ranked:ranked.slice(0,5),profiles,models,as_of:rows.at(-1).date};
}
