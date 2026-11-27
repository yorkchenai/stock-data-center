export function drawCostChart(canvas, history, costs, range) {
  const last = history.at(-1)?.date ?? costs.at(-1)?.date;
  const minimum = last && range ? new Date(Date.parse(last)-range*86_400_000).toISOString().slice(0,10) : "1900-01-01";
  const days = [...new Set([...history,...costs].map(({date})=>date))].sort();
  const rows = new Map(history.map((row)=>[row.date,Number(row.unit_nav)]));
  const byDate = new Map(costs.map((row)=>[row.date,row.unit_cost===null?null:Number(row.unit_cost)]));
  const points = [];
  let cost = null;
  for (const day of days) {
    if (byDate.has(day)) cost=byDate.get(day);
    if (day>=minimum) points.push({day,nav:rows.get(day)??null,cost});
  }
  const rect=canvas.getBoundingClientRect(), ratio=Math.min(devicePixelRatio||1,2);
  if (rect.width < 100) return points.length;
  canvas.width=Math.round(rect.width*ratio);
  canvas.height=240*ratio;
  const ctx=canvas.getContext("2d"), width=rect.width;
  ctx.scale(ratio,ratio);
  const values=points.flatMap((point)=>[point.nav,point.cost]).filter(Number.isFinite);
  if (!values.length) return 0;
  const low=Math.min(...values), high=Math.max(...values), span=high-low||high*.1||1;
  const left=62, right=width-10, top=16, bottom=206;
  const y=(value)=>bottom-(value-low+span*.06)/(span*1.12)*(bottom-top);
  const x=(index)=>left+(right-left)*index/Math.max(1,points.length-1);
  ctx.font="12px system-ui";
  ctx.fillStyle="#496476";
  ctx.strokeStyle="#dce5e4";
  for(let i=0;i<=4;i++){
    const value=low+span*i/4;
    const at=y(value);
    ctx.beginPath();ctx.moveTo(left,at);ctx.lineTo(right,at);ctx.stroke();
    ctx.fillText(value.toFixed(4),1,at+4);
  }
  ctx.fillText(points[0].day,left,229);
  const tail=points.at(-1).day;
  if (points.length>1) ctx.fillText(tail,right-ctx.measureText(tail).width,229);
  for (const [key,color] of [["nav","#08786e"],["cost","#a66112"]]) {
    ctx.beginPath(); ctx.strokeStyle=color; ctx.lineWidth=1.65;
    let prior=null;
    for (const [i,point] of points.entries()) {
      if (!Number.isFinite(point[key])) {
        if (key==="cost") prior=null;
        continue;
      }
      const pixel=y(point[key]);
      if (prior===null) { ctx.moveTo(x(i),pixel); ctx.lineTo(x(i)+.5,pixel); }
      else {
        if (key==="cost") ctx.lineTo(x(i),prior);
        ctx.lineTo(x(i),pixel);
      }
      prior=pixel;
    }
    ctx.stroke();
  }
  return points.length;
}
