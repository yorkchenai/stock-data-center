import { fitChartWithMarkers, renderChartExtremes } from "./chart-extremes.mjs";

const percent = (value) => (value * 100).toFixed(2) + "%";

export function createDrawdownChart() {
  const target = document.getElementById("drawdown-chart");
  const report = document.getElementById("drawdown-values");
  const extremes = document.getElementById("drawdown-extremes");
  let chart, line, markers;

  function display(points) {
    const LC = globalThis.LightweightCharts;
    if (!points.length || !LC) {
      markers?.detach();
      chart?.remove();
      chart = markers = null;
      target.classList.add("empty");
      target.textContent = points.length ? "图表库暂不可用。" : "当前统计区间暂无可计算的曲线。";
      renderChartExtremes([],extremes,percent);
      report.textContent = "";
      return;
    }
    if (!chart) {
      target.classList.remove("empty");
      target.replaceChildren();
      chart = LC.createChart(target,{
        autoSize:true,
        layout:{background:{color:"#fff"},textColor:"#536579",attributionLogo:true},
        grid:{vertLines:{color:"#f1f4f8"},horzLines:{color:"#edf2f6"}},
        timeScale:{borderColor:"#e3e9ef",rightOffset:1,minBarSpacing:0.01},
        rightPriceScale:{borderColor:"#e3e9ef"},
        localization:{locale:"zh-CN",priceFormatter:percent},
      });
      line = chart.addSeries(LC.LineSeries,{
        color:"#a65c61",lineWidth:2,priceLineVisible:false,lastValueVisible:false,
      });
      chart.subscribeCrosshairMove(({time,seriesData})=>{
        const value = seriesData.get(line)?.value;
        report.textContent = typeof time === "string" && Number.isFinite(value) ? `${time} · 回撤 ${percent(value)}` : "";
      });
      markers = LC.createSeriesMarkers(line);
    }
    line.setData(points);
    const labels = renderChartExtremes(points,extremes,percent);
    markers.setMarkers(labels);
    report.textContent = "";
    fitChartWithMarkers(chart,points.length,labels);
  }
  return {display};
}
