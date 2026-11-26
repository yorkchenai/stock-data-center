import { fitChartWithMarkers, renderChartExtremes } from "./chart-extremes.mjs";

const percent = (value) => (value * 100).toFixed(2) + "%";
const signedPercent = new Intl.NumberFormat("zh-CN",{
  style:"percent",signDisplay:"exceptZero",minimumFractionDigits:2,maximumFractionDigits:2,
}).format;

export function createFundCharts() {
  const options = {
    autoSize:true,
    layout:{background:{color:"#fff"},textColor:"#536579",attributionLogo:true},
    grid:{vertLines:{color:"#f1f4f8"},horzLines:{color:"#edf2f6"}},
    timeScale:{borderColor:"#e3e9ef",rightOffset:1,minBarSpacing:0.01},
    rightPriceScale:{borderColor:"#e3e9ef"},
    localization:{locale:"zh-CN",priceFormatter:percent},
  };
  const definitions = {
    fund:{element:"returns-chart", readout:"hover-values", extremes:"returns-extremes", label:"累计收益率", color:"#087e75", format:signedPercent},
    drawdown:{element:"drawdown-chart", readout:"drawdown-values", extremes:"drawdown-extremes", label:"回撤", color:"#a65c61", format:percent},
  };
  const ready = new Map();

  function initialize(name, {element,readout,label,color,format}) {
    const target = document.getElementById(element);
    const LC = globalThis.LightweightCharts;
    const isFund = name === "fund";
    const chart = LC.createChart(target, isFund ? {
      ...options, crosshair:{mode:LC.CrosshairMode.Magnet},
      rightPriceScale:{...options.rightPriceScale,minimumWidth:74},
      localization:{...options.localization,dateFormat:"yyyy-MM-dd",priceFormatter:format},
    } : options);
    const line = chart.addSeries(LC.LineSeries,{
      color,lineWidth:2,priceLineVisible:false,lastValueVisible:false,
      ...(isFund ? {priceFormat:{type:"custom",minMove:0.0001,formatter:format}} : {}),
    });
    const report = document.getElementById(readout);
    chart.subscribeCrosshairMove(({time,seriesData}) => {
      const value = seriesData.get(line)?.value;
      report.textContent = typeof time === "string" && Number.isFinite(value) ? `${time} · ${label} ${format(value)}` : "";
    });
    if (name === "fund") chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      document.getElementById("fund-visible-range").textContent = range ? `图表视窗 ${range.from} 至 ${range.to}` : "";
    });
    const current = {chart,line,markers:LC.createSeriesMarkers(line)};
    ready.set(name,current);
    return current;
  }

  function display(name, points) {
    const config = definitions[name];
    const target = document.getElementById(config.element);
    const extremes = document.getElementById(config.extremes);
    const present = points.length && globalThis.LightweightCharts;
    if (!present) {
      ready.get(name)?.markers.detach();
      ready.get(name)?.chart.remove();
      ready.delete(name);
      target.classList.add("empty");
      target.textContent = points.length ? "图表库暂不可用。" : "当前统计区间暂无可计算的曲线。";
      renderChartExtremes([],extremes,config.format);
      document.getElementById(config.readout).textContent = "";
      if (name === "fund") document.getElementById("fund-visible-range").textContent = "";
      return;
    }
    if (target.classList.contains("empty")) {
      target.classList.remove("empty");
      target.textContent = "";
    }
    const {chart,line,markers} = ready.get(name) ?? initialize(name,config);
    line.setData(points);
    const labels = renderChartExtremes(points,extremes,config.format);
    markers.setMarkers(labels);
    if (name === "fund") chart.clearCrosshairPosition();
    document.getElementById(config.readout).textContent = "";
    fitChartWithMarkers(chart,points.length,labels);
  }

  return {display};
}
