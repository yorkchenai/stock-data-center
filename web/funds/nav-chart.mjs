import { navTimeline } from "./chart-data.mjs";
import { fitChartWithMarkers, renderChartExtremes } from "./chart-extremes.mjs";

const formatted = (value)=>value.toFixed(4);
const signedPercent = new Intl.NumberFormat("zh-CN",{
  style:"percent",signDisplay:"exceptZero",minimumFractionDigits:2,maximumFractionDigits:2,
}).format;
const navColor = "#087e75";
const returnColor = "#3f629f";
const borderColor = "#e3e9ef";

export function createNavReturnChart({element, navReadout, returnReadout, navExtremes, returnExtremes, visibleRange, returnStatus}) {
  let chart, calendar, returns, returnMarkers, navLines = [];
  let navByDate = new Map(), returnByDate = new Map();
  let latestNav;
  function show(time) {
    const nav = navByDate.get(time);
    const gain = returnByDate.get(time);
    navReadout.textContent = typeof time === "string"
      ? (Number.isFinite(nav) ? `${time} · ${formatted(nav)}` : `${time} · 暂无可用净值`)
      : (latestNav ? `最新可见 ${latestNav.time} · ${formatted(latestNav.value)}` : "");
    returnReadout.textContent = Number.isFinite(gain) ? `${time} · 累计收益率 ${signedPercent(gain)}` : "";
  }
  function clear() {
    for (const {markers} of navLines) markers?.detach();
    returnMarkers?.detach();
    chart?.remove();
    chart = calendar = returns = returnMarkers = null;
    navLines = [];
    navByDate.clear();
    returnByDate.clear();
    latestNav = null;
    show();
    renderChartExtremes([],navExtremes,formatted);
    renderChartExtremes([],returnExtremes,signedPercent);
    element.replaceChildren();
    visibleRange.textContent = returnStatus.textContent = "";
  }
  function initialize(LC) {
    element.classList.remove("empty");
    element.replaceChildren();
    chart = LC.createChart(element,{
      autoSize:true, layout:{background:{color:"#fff"},textColor:"#536579",attributionLogo:true},
      grid:{vertLines:{color:"#f1f4f8"},horzLines:{color:"#edf2f6"}},
      timeScale:{borderColor,rightOffset:1,minBarSpacing:0.01},
      leftPriceScale:{borderColor,minimumWidth:56,textColor:navColor},
      rightPriceScale:{borderColor,minimumWidth:74,textColor:returnColor},
      crosshair:{mode:LC.CrosshairMode.Magnet},
      localization:{locale:"zh-CN",dateFormat:"yyyy-MM-dd"},
    });
    calendar = chart.addSeries(LC.LineSeries,{visible:false,priceScaleId:"calendar"});
    chart.subscribeCrosshairMove(({time})=>show(time));
    chart.timeScale().subscribeVisibleTimeRangeChange((range)=>{
      visibleRange.textContent = range ? `图表视窗 ${range.from} 至 ${range.to}` : "";
    });
  }
  function display(fund, mode, start, end, returnPoints, keepViewport = false) {
    const {segments, points, gaps} = navTimeline(fund,mode);
    const inRange = (date)=> (!start || date>=start) && (!end || date<=end);
    const groups = segments.map((segment)=>({...segment,points:segment.points.filter(({time})=>inRange(time))}))
      .filter((segment)=>segment.points.length);
    const visible = points.filter(({time})=>inRange(time));
    const notes = {gaps:gaps.filter(({date})=>inRange(date)),anchors:groups.map(({anchor})=>anchor)};
    const LC = globalThis.LightweightCharts;
    if ((!groups.length && !returnPoints.length) || !LC) {
      clear();
      element.classList.add("empty");
      element.textContent = (groups.length || returnPoints.length) ? "图表库暂不可用。" : "所选日期暂无可用净值和累计收益率。";
      return notes;
    }
    if (!chart) initialize(LC);
    const previous = keepViewport ? chart.timeScale().getVisibleLogicalRange() : null;
    chart.applyOptions({
      leftPriceScale:{visible:groups.length>0},
      rightPriceScale:{visible:returnPoints.length>0},
    });
    for (const {line,markers} of navLines) {
      markers?.detach();
      chart.removeSeries(line);
    }
    if (returns) {
      returnMarkers?.detach();
      chart.removeSeries(returns);
      returns = returnMarkers = null;
    }
    // Keep dates without a verified adjusted NAV on the shared time axis.
    calendar.setData(visible.map(({time})=>({time})));
    const navLabels = renderChartExtremes(visible,navExtremes,formatted);
    const returnLabels = renderChartExtremes(returnPoints,returnExtremes,signedPercent);
    navLines = groups.map(({points:segment})=>{
      const line = chart.addSeries(LC.LineSeries,{
        priceScaleId:"left",color:navColor,lineWidth:2,priceLineVisible:false,lastValueVisible:false,
        priceFormat:{type:"price",precision:4,minMove:0.0001},pointMarkersVisible:segment.length===1,
      });
      line.setData(segment);
      const labels = navLabels.filter(({time})=>time>=segment[0].time && time<=segment.at(-1).time);
      return {line,markers:labels.length ? LC.createSeriesMarkers(line,labels) : null};
    });
    if (returnPoints.length) {
      returns = chart.addSeries(LC.LineSeries,{
        priceScaleId:"right",color:returnColor,lineWidth:2,lineStyle:LC.LineStyle.LargeDashed,
        priceLineVisible:false,lastValueVisible:false,
        priceFormat:{type:"custom",minMove:0.0001,formatter:signedPercent},
      });
      returns.setData(returnPoints);
      // When the lines overlap, leave the NAV labels on the plot and list both sets of extremes below it.
      if (!navLabels.length) returnMarkers = LC.createSeriesMarkers(returns,returnLabels);
    }
    navByDate = new Map(visible.map(({time,value})=>[time,value]));
    returnByDate = new Map(returnPoints.map(({time,value})=>[time,value]));
    latestNav = visible.findLast(({value})=>Number.isFinite(value));
    const dates = new Set([...navByDate.keys(),...returnByDate.keys()]);
    if (previous) chart.timeScale().setVisibleLogicalRange(previous);
    else fitChartWithMarkers(chart,dates.size,navLabels.length ? navLabels : returnLabels);
    chart.clearCrosshairPosition();
    show();
    returnStatus.textContent = returnPoints.length ? "" : "当前统计区间暂无可计算的累计收益率。";
    return notes;
  }
  return {clear, display};
}
