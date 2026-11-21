# 第二阶段交互式图表验收

本阶段从最新 main 的 `29dd5f0bc2a260eb25baa55d73d1f0c46c29cac0` 创建 `feat/interactive-charts`。执行日期为2026-11-21（上海时区）。

## 实现与数据契约

采用随仓库保存的 Lightweight Charts 5.2.0，来源为官方 npm 包 `lightweight-charts@5.2.0` 的 standalone production 构建。Apache-2.0 许可及官方NOTICE保存在 `web/vendor/`，网页保留TradingView归属链接。运行时无需访问CDN。

一个图表包含五个原生pane，价格/K线/MA、成交量/VOL、MACD、RSI及独立ADX共用日期范围和十字光标。前端适配器只读取已计算字段，成交量柱使用volume_lots，均线使用VOL5/VOL10，数值保持后端“手”单位。指标null使用带日期的空白点，数值0保留。字段名称和第一阶段指标定义保持一致。

`stock_analysis.web` 提供本地HTTP服务、真实离线样本和静态演示导出。默认科创50使用已有真实CSV及原 `calculate_indicators`。`--run-dir` 读取成功运行中的指标JSON或CSV。新代码请求直接调用原 `run_analysis`，原有PNG/CSV/JSON/ZIP和记录继续由该流水线生成。没有新增指标计算公式。

## 自动化测试

本地以下命令实际完成。

```bash
python -m unittest discover -s tests -v
node --test tests/test_chart_data.mjs
node --check web/app.mjs
```

- Python共37项测试通过，包含第一阶段原29项，以及8项网页数据、HTTP、失败处理、已保存JSON/CSV复用及静态导出测试。
- 前端5项数据适配测试通过。用明确标注的数值哨兵验证成交量及VOL值不再除以100，MACD直接使用提供的柱值，RSI/ADX/MA原值透传，null与0正确区分，超过120条的全部记录保留。
- JSON/CSV复用测试将指标计算函数设为报错，读取已保存结果仍成功，证明该入口复用已计算值。
- 数据服务返回全部1,551条科创50记录，起止2020-07-01及2026-11-20；首日MA60/RSI12/ADX保持null。
- 将main中全部15个results跟踪文件与本地文件逐字节对比，结果完全相同。原指标回归和五张PNG生成测试通过。

PR检查新增Node测试及真实交互式演示包导出和上传，远端运行结果见PR检查页。

## 浏览器实际操作

在原生Chromium桌面窗口完成以下操作，浏览器DOM助手不可用时采用原生窗口输入及截图核对。

- 默认真实科创50样本载入，1,551条数据全部保留。初始近一年窗口可切换为2020–2026的全部载入历史。
- 鼠标移动及点击图表，日期、五个面板图例与右侧精确数值同步更新。
- 在图表内滚轮缩放、拖动平移，共享日期范围同步变化。
- 日期选择2021-01-01至2021-12-31后显示实际交易日2021-01-04至2021-12-31，沿用已有预热结果。
- 精确定位2020-07-01，OHLC显示源数据，MA/VOL尚未预热值显示为“—”，涨跌幅首行也为“—”。
- MA60复选框控制该均线显隐，其他系列继续显示。
- 页面切换600519，选择2025-01-01至2026-11-20，东方财富返回456行，完成原有流水线并显示交互图表。
- 导出的纯静态演示通过普通Python HTTP服务打开，可读取本地数据及图表库，页面说明离线样本的代码切换范围。

600519本次页面实测的末行日期为2026-11-20，收盘1485.75，成交量67229手，VOL5为42970.2手，VOL10为37669.1手。浏览器显示与原流水线CSV完全一致。对应报告位于执行机器的 `results/sh600519_stock/20261121T153309Z_wvegt8u6/report.json`。

本次浏览器手动验证范围为桌面Chromium。其他浏览器和移动触屏交互尚未专项验收。自动化前端测试覆盖数据适配，画布操作通过上述手动操作确认。

## 演示运行与产物

```bash
python -m stock_analysis.web --port 8765
```

打开 `http://127.0.0.1:8765/`。如需读取已有计算结果，添加 `--run-dir results/<市场代码>_<类型>/<运行目录>`。

静态演示可通过以下命令生成，目标目录需要尚未存在。

```bash
python -m stock_analysis.web --export-demo work/interactive-demo
python -m http.server 8765 --directory work/interactive-demo
```

PR Actions提供 `interactive-demo-<run_id>-<run_attempt>` 下载产物，解压后启动普通HTTP服务即可查看。纯静态演示展示已有样本及日期区间，更换股票与获取新行情由Python交互服务完成。演示所称全部历史为本次载入区间内的全部记录，数据最早日期以所选来源和请求范围为准。
