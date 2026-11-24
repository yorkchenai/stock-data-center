import { AVERAGES, VOLUMES, indexCapabilities } from "./chart-data.mjs";

const UP = "#c74542", DOWN = "#21805f";
const COLORS = {MA5:"#9d6450",MA10:"#6464c4",MA20:"#137485",MA60:"#984e8d",VOL5:"#986642",VOL10:"#5266aa"};
const number = new Intl.NumberFormat("zh-CN",{maximumFractionDigits:2});
const value = (v)=>v==null?"—":number.format(v);
const showPoint = (date, amount)=>amount==null?{time:date}:{time:date,value:amount};

function seriesSpans(rows, key) {
  const spans = [];
  let span = null;
  for (const row of rows) {
    if (row[key] == null) {
      span = null;
    } else {
      if (!span) spans.push(span = []);
      span.push(showPoint(row.date, row[key]));
    }
  }
  return spans;
}

export function createSectorChart(element, readout, toggles, volumeNote, historyNote) {
  let chart, lines = new Map(), controls = new Map(), plotted = [];
  const checked = new Map([...AVERAGES,...VOLUMES].map((key)=>[key,true]));
  function clear({reset = false} = {}) {
    chart?.remove();
    chart = null;
    lines.clear();
    controls.clear();
    element.replaceChildren();
    element.classList.remove("with-volume");
    delete element.dataset.chartMode;
    delete element.dataset.visibleFrom;
    delete element.dataset.visibleTo;
    readout.replaceChildren();
    volumeNote.textContent = historyNote.textContent = "";
    toggles.forEach((group)=>group.replaceChildren());
    if (reset) for (const key of checked.keys()) checked.set(key,true);
  }
  function button(key, unit, group) {
    const item = document.createElement("label");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = checked.get(key);
    toggle.dataset.indicator = key;
    const text = document.createElement("span");
    text.textContent = key === "volume" ? `成交量（${unit}）` : key;
    if (COLORS[key]) text.style.color = COLORS[key];
    const label = document.createElement("output");
    label.dataset.readout = key;
    label.textContent = "—";
    toggle.addEventListener("change",()=>{
      checked.set(key,toggle.checked);
      for (const line of lines.get(key) ?? []) line.applyOptions({visible:toggle.checked});
    });
    item.append(toggle,text,label);
    group.append(item);
    controls.set(key,label);
  }
  function detail(row) {
    const fields = [["开",row?.open],["高",row?.high],["低",row?.low],["收",row?.close]];
    readout.textContent = row ? [row.date,...fields.map(([name,price])=>`${name} ${value(price)}`)].join(" · ") : "";
    for (const [key,out] of controls) out.textContent = value(row?.[key]);
  }

  function display(history, rows) {
    clear();
    if (!rows.length || !globalThis.LightweightCharts) {
      element.classList.add("empty");
      element.textContent = rows.length ? "图表库暂不可用。" : "所选日期暂无可验证的指数行情。";
      return;
    }
    const LC = globalThis.LightweightCharts;
    const {candles,volume} = indexCapabilities(rows,history.volume_unit);
    element.classList.remove("empty");
    element.classList.toggle("with-volume",volume);
    element.dataset.chartMode = candles?"candles":"close";
    historyNote.textContent = candles ? "" : "当前区间缺少完整可验证的开高低行情，暂以收盘价走势展示。";
    volumeNote.textContent = volume ? "" : "成交量数据尚未核实，暂不可用。";
    chart = LC.createChart(element,{
      autoSize:true,layout:{background:{color:"#fff"},textColor:"#536579",attributionLogo:true,
        panes:{enableResize:false,separatorColor:"#e2e9ef"}},
      grid:{vertLines:{color:"#f1f4f8"},horzLines:{color:"#edf2f6"}},
      rightPriceScale:{minimumWidth:80},
      crosshair:{mode:LC.CrosshairMode.Normal},timeScale:{rightOffset:1},
      localization:{locale:"zh-CN"},
    });
    const options = {priceLineVisible:false,lastValueVisible:false};
    if (candles) {
      const price = chart.addSeries(LC.CandlestickSeries,{...options,upColor:UP,downColor:DOWN,
        wickUpColor:UP,wickDownColor:DOWN,borderVisible:false});
      price.setData(rows.map(({date,open,high,low,close})=>open==null?{time:date}:{time:date,open,high,low,close}));
    } else {
      // Separate spans for genuinely missing sessions, even if the chart library joins whitespace.
      const baseline = chart.addSeries(LC.LineSeries,{visible:false});
      baseline.setData(rows.map(({date})=>({time:date})));
      for (const span of seriesSpans(rows,"close")) {
        chart.addSeries(LC.LineSeries,{...options,color:"#087e75",lineWidth:2,pointMarkersVisible:span.length===1}).setData(span);
      }
    }
    for (const key of AVERAGES) {
      const line = chart.addSeries(LC.LineSeries,{...options,visible:checked.get(key),color:COLORS[key],lineWidth:1});
      line.setData(rows.map((row)=>showPoint(row.date,row[key])));
      lines.set(key,[line]);
      button(key,null,toggles[0]);
    }
    if (volume) {
      const evidence=document.createElement("a");
      evidence.href=history.source.volume_unit_evidence;
      evidence.target="_blank";
      evidence.rel="noopener noreferrer";
      evidence.textContent="单位与来源";
      volumeNote.replaceChildren("指数样本证券汇总 · ",evidence);
      const pane = chart.addPane();
      chart.panes()[0].setStretchFactor(7);
      pane.setStretchFactor(3);
      const format = {type:"volume"};
      const bars = pane.addSeries(LC.HistogramSeries,{...options,visible:checked.get("volume"),priceFormat:format});
      bars.setData(rows.map((row)=>row.volume==null?{time:row.date}:{
        time:row.date,value:row.volume,color:row.open==null?"#8296a5":row.close>=row.open?UP:DOWN,
      }));
      lines.set("volume",[bars]);
      button("volume",history.volume_unit,toggles[1]);
      for (const key of VOLUMES.slice(1)) {
        lines.set(key,seriesSpans(rows,key).map((span)=>{
          const line=pane.addSeries(LC.LineSeries,{...options,visible:checked.get(key),color:COLORS[key],lineWidth:1,
            priceFormat:format,pointMarkersVisible:span.length===1});
          line.setData(span);
          return line;
        }));
        button(key,null,toggles[1]);
      }
    }
    plotted = new Map(rows.map((row)=>[row.date,row]));
    const latest = rows.findLast((row)=>row.close!=null);
    chart.subscribeCrosshairMove(({time})=>detail(typeof time==="string" ? plotted.get(time) : latest));
    chart.timeScale().subscribeVisibleTimeRangeChange((range)=>{
      if (range) {
        element.dataset.visibleFrom=String(range.from);
        element.dataset.visibleTo=String(range.to);
      }
    });
    chart.timeScale().fitContent();
    detail(latest);
  }
  return {clear, display};
}
