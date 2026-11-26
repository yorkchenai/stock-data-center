export function renderChartExtremes(points, readout, format) {
  let peak, trough;
  for (const point of points) {
    if (!Number.isFinite(point.value)) continue;
    if (!peak || point.value>peak.value) peak = point;
    if (!trough || point.value<trough.value) trough = point;
  }

  // A flat interval has one point that represents both extremes.
  const extremes = !peak ? [] : peak===trough ? [
    {point:peak,label:"峰谷值",text:"峰谷",color:"#536579",shape:"circle",position:"aboveBar"},
  ] : [
    {point:peak,label:"峰值",text:"峰",color:"#a94344",shape:"arrowDown",position:"aboveBar"},
    {point:trough,label:"谷值",text:"谷",color:"#087e75",shape:"arrowUp",position:"belowBar"},
  ];
  readout.hidden = !extremes.length;
  readout.replaceChildren(...extremes.map(({point,label})=>{
    const item = document.createElement("span");
    item.textContent = `${label} ${point.time} · ${format(point.value)}`;
    return item;
  }));
  return extremes.map(({point,text,color,shape,position})=>({time:point.time,text,color,shape,position}))
    .sort((a,b)=>a.time.localeCompare(b.time));
}

export function fitChartWithMarkers(chart, pointCount) {
  const scale = chart.timeScale();
  const gutter = 12;
  const width = scale.width();
  if (pointCount<2 || width<=2*gutter) {
    scale.fitContent();
    return;
  }
  // Keep markers at the first and last data points inside the plotting pane.
  const padding = pointCount*gutter/(width-2*gutter);
  scale.setVisibleLogicalRange({from:-padding,to:pointCount-1+padding});
}
