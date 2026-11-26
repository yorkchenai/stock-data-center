export function renderChartExtremes(points, readout, format) {
  let peak, trough;
  for (const point of points) {
    if (!Number.isFinite(point.value)) continue;
    if (!peak || point.value>peak.value) peak = point;
    if (!trough || point.value<trough.value) trough = point;
  }

  // A flat interval has one point that represents both extremes.
  const extremes = !peak ? [] : peak===trough ? [
    {point:peak,label:"峰谷值",color:"#536579",shape:"circle",position:"aboveBar"},
  ] : [
    {point:peak,label:"峰值",color:"#a94344",shape:"arrowDown",position:"aboveBar"},
    {point:trough,label:"谷值",color:"#087e75",shape:"arrowUp",position:"belowBar"},
  ];
  readout.hidden = !extremes.length;
  readout.replaceChildren(...extremes.map(({point,label})=>{
    const item = document.createElement("span");
    item.textContent = `${label} ${point.time} · ${format(point.value)}`;
    return item;
  }));
  return extremes.map(({point,color,shape,position})=>({time:point.time,text:format(point.value),color,shape,position}))
    .sort((a,b)=>a.time.localeCompare(b.time));
}

export function fitChartWithMarkers(chart, pointCount, markers) {
  const scale = chart.timeScale();
  const fontSize = chart.options().layout.fontSize;
  const gutter = Math.max(12,...markers.map(({text})=>Math.ceil(text.length*fontSize*0.38+4)));
  const width = scale.width();
  if (!pointCount || width<=2*gutter) {
    scale.fitContent();
    return;
  }
  // Keep markers at the first and last data points inside the plotting pane.
  const padding = pointCount*gutter/(width-2*gutter);
  scale.setVisibleLogicalRange({from:-padding,to:pointCount-1+padding});
}
