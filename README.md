# stock-data-center

A 股股票和主要指数的日线数据、技术指标与静态图表分析引擎。

## 交互式技术分析界面

从仓库根目录启动本地服务，运行时使用已有 Python 依赖。图表库随仓库保存，启动科创50演示可离线完成，无需 Node 或前端构建步骤。

```bash
python -m pip install -r requirements.txt
python -m stock_analysis.web --port 8765
```

浏览器打开 `http://127.0.0.1:8765/`。默认载入 `results/000688_daily.csv` 的全部1,551条真实日线，区间为2020-07-01至2026-11-20。演示指标由第一阶段 `calculate_indicators` 计算，页面直接读取结果。初始显示近一年，“全部历史”可以查看本次载入区间的完整记录。显示区间可缩放和平移，五个面板共用同一时间轴和十字光标。

输入股票/指数代码、类型和日期后选择“加载行情”。新代码或超出载入范围的请求由 Python 调用既有 `run_analysis`，继续产生原有行情CSV、逐日指标CSV/JSON、五张PNG、ZIP及运行记录。相同代码在已载入区间内切换日期仅改变视窗，沿用已计算指标和预热历史。切换历史请求的起点会改变递推指标种子，计算口径与第一阶段一致。

页面可通过“定位”跳到指定交易日。鼠标移动到任一面板时，所有图例和交易日明细都显示该日的现有数值。均线和指标图例的复选框控制显示。初始缺失指标以图表留白和明细“—”显示，原始精度可在数值悬停提示中查看。遇到休市、停牌或范围外日期，定位操作显示提示。

五面板依次为价格与K线/MA、成交量/VOL、MACD、RSI及独立补充ADX。固定五层分析顺序显示在图表上方，ADX单独标识。

- `volume_lots`、VOL5、VOL10均直接使用后端手数，界面统一标注“手”。
- MACD、RSI、ADX和各均线直接读取后端逐日结果，前端仅适配图表数据及显示格式。
- 未预热值从JSON null映射为有日期的空白点，数值0保持为0。

### 复用已有指标文件

```bash
python -m stock_analysis.web --run-dir results/sh600519_stock/<运行目录> --port 8765
```

指定目录需要成功的 `report.json`，以及完整的 `indicators.json` 或 `indicators.csv`。优先读取JSON，缺少JSON时读取CSV；该路径直接复用已保存指标。需要第一阶段新运行目录中的完整字段，包括RSI12和VOL5/10。

### 下载或导出真实数据演示

```bash
python -m stock_analysis.web --export-demo work/interactive-demo
python -m http.server 8765 --directory work/interactive-demo
```

打开 `http://127.0.0.1:8765/` 查看。导出目录包含网页、图表库、许可文件及真实指标数据，可复制到其他机器。页面采用ES modules和fetch，需通过HTTP服务访问。纯静态演示支持查看、定位及区间切换，更换股票代码由上述Python交互服务提供。导出目标必须为新的独立目录。

PR检查的Actions页面还提供 `interactive-demo-<run_id>-<run_attempt>` Artifact，下载解压后以 `python -m http.server 8765 --directory <解压目录>` 打开。Artifact请求保留30天。

### 技术与验证

采用 Apache-2.0 的 TradingView Lightweight Charts 5.2.0，使用一个图表的五个原生pane，共享日期轴与游标。前端为原生HTML/CSS/ES modules，服务使用Python标准库HTTP server。库的固定版本、许可和NOTICE保存在 `web/vendor/`，页面保留TradingView归属链接。此入口面向本地研究使用，默认监听127.0.0.1。

```bash
python -m unittest discover -s tests -v
node --test tests/test_chart_data.mjs
```

Node 22或更新版本用于前端测试。测试覆盖原有功能、HTTP参数与失败处理、既有JSON/CSV复用、真实数据演示导出、成交量单位不重复换算、预热空值和超过120日的数据保留。阶段验收见 [交互式图表验收记录](docs/interactive-charts-validation.md)。

## 安装与运行

Python 3.11 或更新版本，在仓库根目录执行。

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python -m stock_analysis 600519 --start 2020-01-01 --end 2026-11-20
python -m stock_analysis sz000001 --start 2025-01-01 --end 2026-11-20
python -m stock_analysis 300750 --start 2025-01-01 --end 2026-11-20
python -m stock_analysis 688981 --start 2025-01-01 --end 2026-11-20
python -m stock_analysis sh000001 --kind index --start 2025-01-01 --end 2026-11-20
python -m stock_analysis 399006 --start 2025-01-01 --end 2026-11-20
```

`--start` 默认为 2020-01-01。`--end` 默认为上海时区的昨天，以避开当天未收盘的日线。`--window 120` 控制绘图末尾展示条数，计算保留整个输入区间。`--source auto` 按东方财富、腾讯顺序尝试，也可显式选择 `eastmoney` 或 `tencent`。请求与校验失败均记录在报告，全部失败时命令返回非零退出码。

离线重算已有真实行情。

```bash
python -m stock_analysis 000688 --input results/000688_daily.csv --start 2020-07-01 --end 2026-11-20
python scripts/generate_indicators.py
python scripts/generate_indicators.py 600519 --start 2025-01-01 --end 2026-11-20
python -m unittest discover -s tests -v
```

旧绘图脚本无参数时继续使用已有科创50 CSV，输出改到新的运行目录。旧绘图工作流上传运行产物供下载。历史抓取及诊断脚本保留用于复核此前实验，新增多代码分析统一使用 `python -m stock_analysis`。

## 代码解析范围

| 类型 | 路由规则 | 示例 |
| --- | --- | --- |
| 沪市股票 | 600、601、603、605、688、689 开头 | 600519、688981 |
| 深市股票 | 000、001、002、003、300、301 开头 | sz000001、002594、300750 |
| 沪市指数 | `--kind index` 或 `sh` 前缀的 000 开头代码 | sh000001、sh000300 |
| 深市指数 | 399 开头 | 399001、399006 |

自动识别的沪市常用指数包括 000001、000016、000300、000688、000852、000905、000906、000985。裸 `000001` 强制消歧，可用 `sz000001`、`sh000001`，或 `--kind stock/index`。这些沪市指数码也可用显式 `sz` 前缀或 `--kind stock` 指定为深市股票。显式市场与类型不匹配时报错。

路由规则只确定接口参数，代码是否存在及历史可用性由实际返回和校验决定。在线验证范围见 [本阶段验收记录](docs/multi-instrument-validation.md)。其他个股、指数、退市或新上市标的尚未逐一在线验证。北交所、港股、ETF 和 980 等其他指数编码尚未接入。

## 数据与输出

每次运行创建 `results/<市场代码>_<stock或index>/<UTC时间>_<随机后缀>/`，例如 `results/sh600519_stock/20261121T143405Z_k6rgorlo/`。同代码重跑、并发运行以及 `sh000001` 与 `sz000001` 分别保存。已有 `results/000688_daily.csv`、`results/charts/` 保留。

| 文件 | 内容 |
| --- | --- |
| `daily.csv` | 来源行情，经单位规范化和排序后的 date、open、close、high、low、volume_lots、turnover_cny |
| `indicators.csv` | 全区间原始字段及逐日衍生指标，初始未定义值为空 |
| `indicators.json` | 相同逐日记录，日期为 YYYY-MM-DD，NaN 为标准 JSON null |
| `charts/01_price_ma.png` | K线和 MA5、MA10、MA20、MA60 |
| `charts/02_volume_ma.png` | 成交量和 VOL5、VOL10 |
| `charts/03_macd.png` | DIF、DEA、两倍柱值 |
| `charts/04_rsi.png` | RSI6、RSI12、RSI14、RSI24 和 30/50/70 参考线 |
| `charts/05_adx.png` | ADX14、+DI、−DI |
| `report.json` | schema_version=1、run_id、标的、区间、来源尝试、停牌分类、五层顺序、运行状态及保存位置 |
| `record.json` | 单次运行简要记录，包含代码、请求/实际来源、区间、状态、时间、输出位置和 Actions 运行链接 |
| `preview.html` | 离线查看五张图和校验结果，图像内嵌，数据文件可从解压目录打开 |
| `manifest.json` | ZIP 内容文件的大小与 SHA-256 校验清单 |

每次运行自动生成 `<市场代码>_<类型>_<运行目录>.zip` 及 `.zip.sha256`，位于该标的目录，ZIP 包含表中全部文件。独立简要记录另外存入 `<output-root>/run-records/<run_id>.json`，并发运行各自写记录。ZIP 先写临时文件，再原子发布。取数失败时也打包已有诊断，记录 `status=failed`；打包失败返回非零状态并记录 `artifact_error`，清除未完整发布的包。新产物及运行记录由 Git 忽略。

### 保存与下载

| 保存位置 | 生命周期与用途 | 访问方式 |
| --- | --- | --- |
| 本地或云端工作目录、`work/`、系统临时目录 | 取决于执行环境保留期限，运行结束后应导出需要的包 | CLI 输出中的 `artifacts.archive`，解压后打开 `preview.html` |
| GitHub Actions Artifacts | 工作流请求保留30天，受仓库保留上限约束，到期或运行被删除后可能消失 | Actions 运行页底部 Artifacts 和运行 Summary 中的下载链接 |
| 自有持久化目录 | 由所选磁盘、备份和保留策略维护 | 使用 `--output-root /mnt/stock-archives`，或将 ZIP、校验文件和记录复制到自有存储 |
| GitHub Release 附件 | 独立于 Actions Artifacts 到期策略，持续保存至有人删除相关 Release 或附件 | 手动工作流勾选 `persist` 后，在 Releases 下载 ZIP、校验文件和运行记录 |

在 Actions 中选择 **Generate stock indicator charts → Run workflow**，选择目标分支，输入 `symbol`、`kind`、`start`、`end`。`end` 为空时使用上海时区昨天。默认生成临时 Actions Artifact；需要长期保留时勾选 `persist`。主分析任务只有仓库读取权限，长期保存任务单独使用 `contents: write`。每次长期保存使用唯一 `analysis-<run_id>-<run_attempt>` 标签并指向该次代码提交，先上传 Draft Release，成功后发布，保持仓库现有访问范围。该工作流复用了原工作流文件，在 PR 合并前也可选择分支运行。

PR 测试工作流会用仓库内真实科创50历史生成 `analysis-sample-<run_id>-<run_attempt>` 下载产物。原 `chart_requests` 推送入口继续离线生成科创50产物。

下载 Artifact 需要登录有仓库读取权限的 GitHub 账号。下载后先解压 Actions 外层包，再解压其中的单次运行 ZIP，打开 `preview.html`。校验包可执行 `sha256sum -c <包名>.zip.sha256`。文件逐项校验依据包内 `manifest.json`。移动包后，记录中的绝对路径保留原运行位置，包内相对路径继续可用。

Artifacts 下载及保留规则见 [GitHub 文档](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)。Release 的附件与访问规则见 [GitHub 文档](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。本次 Release 上传路径尚未实际执行验收，当前执行环境的 GitHub CLI API 请求返回 Forbidden。

东方财富使用 `secid=1.<沪市代码>` 或 `0.<深市代码>`，日线 `klt=101`，不复权 `fqt=0`。腾讯使用 AKShare `stock_zh_a_hist_tx(..., adjust="")`，该函数支持股票和指数，按年份取历史，返回成交量为股、成交额为元。这里固定 AKShare 1.20.65 以固定该字段契约，成交量除以100转换为手。此前 `index_zh_daily_tx` 固定使用前复权参数，本次使用显式不复权接口统一主备口径。单次运行采用一个来源的完整序列。

数据校验拒绝缺字段、重复日期、非法日期、非有限值、非正价格、OHLC 上下界错误、负量额及非交易日。缺口单独记录，保留停牌零成交数据，不补造行。XSHG 日历作为沪深交易日参考，比较完整请求区间。指数内部交易日缺口触发备用源；首尾缺口可能来自发布日期或截断，报告保留。报告保留全部 `missing_sessions`，并按有来源的证据登记拆分为 `confirmed_suspension_sessions` 和 `unverified_missing_sessions`。`stock_analysis/suspensions.json` 当前仅登记核实过的中芯国际 2025-09-01 至 2025-09-08 停牌区间和 2025-09-09 复牌日，记录两份公告链接及核实日期。其他日期、其他代码的缺口继续保持未核实。停牌期间若来源返回行情，会记录 `suspension_data_conflicts`，不自动删除原始行。`active_session_dates_match` 仅表示本次日期与已登记停牌证据一致。股票的 `completeness_verified` 继续为 false，因为上市及全部停牌资料覆盖尚未完整建立。核实证据见 [补充验收记录](docs/pr1-followup-validation.md)。

## 指标口径与初始化

所有指标按输入区间升序、单向递推。只使用当前及此前记录。开始日期改变会改变递推种子，做区间比较时先加载共同的足够长历史再切片。图表默认展示末120条，预热计算使用完整输入。各指标有首个可计算位置，递推指标仍需要更长历史减弱种子影响。

| 指标 | 口径与首个有效位置，位置从0开始 |
| --- | --- |
| OHLC、量额 | 保留来源字段，`volume_lots` 单位手，`turnover_cny` 单位人民币元 |
| change_pct | `(close / 前收盘 - 1) * 100`，首行 NaN；不复权，除权除息日可能跳变 |
| MA5/10/20/60 | 最近 N 条记录算术均值，首个有效位置 N−1 |
| VOL5/10 | 最近 N 条成交量手数均值，首个有效位置 N−1；保留旧列名 VMA5/10 为同值别名 |
| EMA12/26 | `alpha=2/(N+1)`，首条 close 为种子，`adjust=False`，从位置0输出 |
| DIF、DEA、MACD_hist | DIF=EMA12−EMA26；DEA 对 DIF 做 EMA9，首条 DIF=0 为种子；柱值为 **2×(DIF−DEA)**，从位置0输出 |
| RSI6/12/14/24 | Wilder 平滑。前 N 次变动的平均涨额和跌额为种子，之后 `(前值×(N−1)+本次值)/N`，首个有效位置 N。只有上涨为100，只有下跌为0，完全平盘为50 |
| +DI、−DI | Wilder TR、+DM、−DM。比较当前 high−前 high 与前 low−当前 low，严格较大且大于0者为有效 DM，相等取0。前14次变动之和初始化于位置14，随后 `前和×13/14+本次值`。DI=100×平滑DM/平滑TR |
| ADX14 | DX=100×abs(+DI−−DI)/(+DI+−DI)，位置14到27共14个DX的均值初始化于位置27，之后 Wilder 递推 |

TR 为 high−low、abs(high−前close)、abs(low−前close) 的最大值。平滑 TR=0 时 DI=0，DI 和=0 时 DX=0。初始化前保持 NaN，短序列允许计算并保留尚未预热的 NaN，不回填、不以0替代未定义值。CSV 保留双精度输出，JSON 最多15位小数。不同软件的种子、预热或复权方式可能不同。

## 模块接口与五层框架

- `symbols.py` 负责代码、市场与标的类型。
- `data.py` 负责主备来源和单位规范化。
- `validation.py` 负责 OHLCV 校验和交易日缺口报告。
- `indicators.py` 的 `calculate_indicators(frame)` 返回独立 DataFrame，可供未来交互式图表使用。
- `charts.py` 消费已计算的 DataFrame，不含指标计算公式。
- `pipeline.py` 串联入口、独立输出和报告。
- `artifacts.py` 保存 ZIP、离线预览、文件校验清单和独立运行记录。

```python
import pandas as pd
from stock_analysis import calculate_indicators, resolve_symbol
from stock_analysis.pipeline import run_analysis

frame = pd.read_csv("results/000688_daily.csv")
indicators = calculate_indicators(frame)
# 也可直接获得在线分析的 DataFrame 和运行报告
indicators, report = run_analysis(resolve_symbol("600519"), "2025-01-01", "2026-11-20")
```

未来交互式图表可按 `date` 将 `indicators.json` 中的 OHLC/MA、volume/VOL、DIF/DEA/MACD_hist、RSI、ADX/DI 列分组，同步五图日期和游标。字段含义及单位见上表，日期为唯一升序键，初始未定义指标为 null，停牌日保留缺口。前端读取已计算数值并控制展示区间，计算公式继续由指标模块维护。`report.json` 的 `schema_version=1` 标识数据契约。

报告固定保留以下顺序，后续分析与回测模块可据此扩展。

1. 价格定位置
2. 均线判趋势
3. 成交量看配合
4. MACD看动量变化
5. RSI看相对强弱

ADX 为独立补充指标。本阶段交付数据和指标引擎、静态图表及框架元数据。未来分析报告和回测需继续接入停牌与公司行为资料、交易费用及无前视执行时序。
