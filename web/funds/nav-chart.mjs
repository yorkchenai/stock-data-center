import { navTimeline } from "./chart-data.mjs";

export function createNavChart(element, readout) {
  let chart, lines = [], axis;
  let points = new Map();
  let latest = null;
  const formatted = (value)=> value.toFixed(4);
  const show = (time, fallback = true) => {
    const value = points.get(time);
    const index = typeof time === "string";
    readout.textContent = index
      ? (value == null ? `${time} · 复权值无法核验` : `${time} · ${formatted(value)}`)
      : (fallback && latest ? `最新可见 ${latest.time} · ${formatted(latest.value)}` : "");
  };
  function clear() {
    chart?.remove();
    chart = axis = null;
    lines = [];
    readout.textContent = "";
    element.textContent = "";
  }
  function display(fund, mode, start, end) {
    const {segments, points:timeline, gaps} = navTimeline(fund,mode);
    const range = (point)=> (!start || point.time>=start) && (!end || point.time<=end);
    const groups = segments.map((segment)=>({...segment, points:segment.points.filter(range)}))
      .filter((segment)=>segment.points.length);
    const visible = timeline.filter(range);
    if (!groups.length || !globalThis.LightweightCharts) {
      clear();
      element.classList.add("empty");
      element.textContent = groups.length ? "图表库暂不可用。": "所选日期暂无可用净值。";
      return {gaps:gaps.filter(({date})=>range({time:date})), anchors:[]};
    }
    if (!chart) {
      element.classList.remove("empty");
      element.replaceChildren();
      const LC = globalThis.LightweightCharts;
      chart = LC.createChart(element, {
        autoSize:true, layout:{background:{color:"#fff"},textColor:"#536579",attributionLogo:true},
        grid:{vertLines:{color:"#f1f4f8"},horzLines:{color:"#edf2f6"}},
        localization:{locale:"zh-CN",priceFormatter:formatted},
      });
      axis = chart.addSeries(LC.LineSeries,{visible:false});
      chart.subscribeCrosshairMove(({time})=>show(time));
    }
    lines.forEach((line)=>chart.removeSeries(line));
    lines = groups.map((group)=>{
      const line = chart.addSeries(globalThis.LightweightCharts.LineSeries,{
        color:"#087e75",lineWidth:2,priceLineVisible:false,lastValueVisible:false,
        pointMarkersVisible:group.points.length===1,
      });
      line.setData(group.points);
      return line;
    });
    axis.setData(visible.map(({time})=>({time})));
    points = new Map(visible.map(({time,value})=>[time,value]));
    latest = visible.findLast((point)=>point.value!=null);
    chart.timeScale().fitContent();
    show();
    return {gaps:gaps.filter(({date})=>range({time:date})), anchors:groups.map((group)=>group.anchor)};
  }
  return {clear, display};
}
