const percent = (value) => (value * 100).toFixed(2) + "%";

export function createFundCharts() {
  const options = {
    autoSize:true,
    layout:{background:{color:"#fff"},textColor:"#536579",attributionLogo:true},
    grid:{vertLines:{color:"#f1f4f8"},horzLines:{color:"#edf2f6"}},
    timeScale:{borderColor:"#e3e9ef",rightOffset:1},
    rightPriceScale:{borderColor:"#e3e9ef"},
    localization:{locale:"zh-CN",priceFormatter:percent},
  };
  const definitions = {
    fund:{element:"returns-chart", readout:"hover-values", series:[
      {key:"fund", label:"基金", color:"#087e75"},
      {key:"benchmark", label:"基准", color:"#5d73b3"},
    ]},
    drawdown:{element:"drawdown-chart", readout:"drawdown-values",
      series:[{key:"drawdown", label:"回撤", color:"#a65c61"}]},
  };
  const ready = new Map();

  function initialize(name, {element,readout,series}) {
    const target = document.getElementById(element);
    const chart = LightweightCharts.createChart(target, options);
    const lines = new Map(series.map(({key,color})=>[key,chart.addSeries(LightweightCharts.LineSeries,{
      color,lineWidth:2,priceLineVisible:false,lastValueVisible:false,
    })]));
    const report = document.getElementById(readout);
    chart.subscribeCrosshairMove(({time,seriesData}) => {
      const values = series.flatMap(({key,label}) => {
        const line = lines.get(key), data = seriesData.get(line);
        return data && line.options().visible ? [label + " " + percent(data.value)] : [];
      });
      report.textContent = typeof time === "string" && values.length ? `${time} · ${values.join(" · ")}` : "";
    });
    if (name === "fund") chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      document.getElementById("fund-visible-range").textContent = range ? `图表视窗 ${range.from} 至 ${range.to}` : "";
    });
    const current = {chart,lines};
    ready.set(name,current);
    return current;
  }

  function display(name, points) {
    const config = definitions[name];
    const target = document.getElementById(config.element);
    const present = points[name].length && typeof LightweightCharts !== "undefined";
    if (!present) {
      ready.get(name)?.chart.remove();
      ready.delete(name);
      target.classList.add("empty");
      target.textContent = points[name].length ? "图表库暂不可用。" : "当前统计区间暂无可计算的曲线。";
      document.getElementById(config.readout).textContent = "";
      if (name === "fund") document.getElementById("fund-visible-range").textContent = "";
      return;
    }
    if (target.classList.contains("empty")) {
      target.classList.remove("empty");
      target.textContent = "";
    }
    const {chart,lines} = ready.get(name) ?? initialize(name,config);
    for (const [key,line] of lines) line.setData(points[key]);
    chart.timeScale().fitContent();
  }

  function showLine(key, checked) {
    ready.get("fund")?.lines.get(key)?.applyOptions({visible:checked});
  }

  return {display, showLine};
}
