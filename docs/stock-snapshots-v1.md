# 日线快照 v1 与发布前审查

MVP 覆盖 `sz300078` 思创智联、`sh600519` 贵州茅台、`sh688981` 中芯国际、`sz399006` 创业板指。名称由四标的目录维护，在本轮本地验证中与行情名称一致。发布入口使用公开 HTTPS GET。文件按下列相对路径组织，入口只服务已发布的数据。

| 路径 | 内容 |
| --- | --- |
| `manifest.json` | 四个标的的状态、来源、数据时间、校验结果、相对路径和 SHA-256 |
| `<symbol>/latest.json` | 最近最多 60 个交易日的完整字段，末项是最后一条有效日线 |
| `<symbol>/history.json` | 从固定计算起点开始的全部有效日线及指标 |

以下是合并后预定的稳定地址。当前 PR 仅构建和审查，这些新增地址尚未发布。按当前授权配置，首次发布时文件会标识 `publication_blocked`，`rows` 为空。

| 标的 | Pages 快照 | GitHub Raw 镜像 |
| --- | --- | --- |
| 目录 | [manifest](https://yorkchenai.github.io/stock-data-center/data/v1/manifest.json) | [manifest](https://raw.githubusercontent.com/yorkchenai/stock-data-center/snapshots-v1/data/v1/manifest.json) |
| `sz300078` | [最近 60 日](https://yorkchenai.github.io/stock-data-center/data/v1/sz300078/latest.json) · [历史](https://yorkchenai.github.io/stock-data-center/data/v1/sz300078/history.json) | [最近 60 日](https://raw.githubusercontent.com/yorkchenai/stock-data-center/snapshots-v1/data/v1/sz300078/latest.json) · [历史](https://raw.githubusercontent.com/yorkchenai/stock-data-center/snapshots-v1/data/v1/sz300078/history.json) |
| `sh600519` | [最近 60 日](https://yorkchenai.github.io/stock-data-center/data/v1/sh600519/latest.json) · [历史](https://yorkchenai.github.io/stock-data-center/data/v1/sh600519/history.json) | [最近 60 日](https://raw.githubusercontent.com/yorkchenai/stock-data-center/snapshots-v1/data/v1/sh600519/latest.json) · [历史](https://raw.githubusercontent.com/yorkchenai/stock-data-center/snapshots-v1/data/v1/sh600519/history.json) |
| `sh688981` | [最近 60 日](https://yorkchenai.github.io/stock-data-center/data/v1/sh688981/latest.json) · [历史](https://yorkchenai.github.io/stock-data-center/data/v1/sh688981/history.json) | [最近 60 日](https://raw.githubusercontent.com/yorkchenai/stock-data-center/snapshots-v1/data/v1/sh688981/latest.json) · [历史](https://raw.githubusercontent.com/yorkchenai/stock-data-center/snapshots-v1/data/v1/sh688981/history.json) |
| `sz399006` | [最近 60 日](https://yorkchenai.github.io/stock-data-center/data/v1/sz399006/latest.json) · [历史](https://yorkchenai.github.io/stock-data-center/data/v1/sz399006/history.json) | [最近 60 日](https://raw.githubusercontent.com/yorkchenai/stock-data-center/snapshots-v1/data/v1/sz399006/latest.json) · [历史](https://raw.githubusercontent.com/yorkchenai/stock-data-center/snapshots-v1/data/v1/sz399006/history.json) |

## JSON 合同

- 每个文件有 `schema_version: 1`、`symbol`、`kind`、`status` 和 UTC 格式的 `generated_at_utc`。目录的 `symbol` 为 `null`，来源、单位和缺口等信息按标的列在 `instruments`。目录还记录生成代码的 `commit_sha`。
- 单标的文件提供 `instrument`、`instrument_name`、`source`、`as_of_utc`（成功抓取时间）、`last_trade_date`、`expected_session`、`adjustment: "none"`、`calculation_start`（`2025-01-01`）、`calculation_first_trade_date`、`units`、`validation`、`attempts`、`row_count` 和 `calculated_row_count`。`history` 为同目录历史文件的相对链接。
- `rows` 日期升序，包含 `date`、`open`、`high`、`low`、`close`、`volume_lots`、`turnover_cny`、`change_pct`、`MA5/10/20/60`、`VOL5/10`、`EMA12/26`、`DIF`、`DEA`、`MACD_hist`、`RSI6/12/14/24`、`ADX14`、`+DI`、`-DI`。原引擎保留的 `VMA5/10` 是 `VOL5/10` 别名。股票价格为元、指数为点，成交量和均量为手、成交额为元。
- 先从固定起点算完整序列，再截取最近 60 条。原引擎预热值编码成 `null`。`MACD_hist = 2 × (DIF − DEA)`，ADX 独立于五层。历史起点之前的日线不在本版范围内。
- `validation` 区分日历预期交易日、已确认停牌和未核实缺口。`ok` 表示本轮数据达到应到交易日且没有未核实缺口，股票整体完整性仍以 `completeness_verified` 与说明字段为准。`partial` 表示当前日期已到但历史有未核实缺口，`stale` 表示最后一条行情早于应到交易日。`unavailable` 表示本次抓取或日历不可用，`publication_blocked` 表示当前无可用的双渠道授权。后二者返回 `rows: []`，无可用行情日期、来源或抓取时间。
- 上海时间 17:00 起将该日已完成交易计入应到日期，周末和节假日按 XSHG 日历。`stale` 是生成时的状态，客户端还要比较当前时间与 `fresh_until_utc`。该时间取下次应到日线截止与授权期限中较早者。文件未按期刷新，即使仍写着 `status: "ok"`，超过该时间也应视为过期。取数全部失败时下次发布使用 `unavailable`，不复用旧内容伪装成功。

## 授权与更新机制

东方财富的法律声明和服务条款有事先书面许可要求。沪深交易规则亦有向第三方传播交易信息的许可条款。针对腾讯当前使用的历史日线接口，本轮没有核实到覆盖公开再分发的授权。因此 `config/snapshots.json` 的授权列表为空，公开输出只包含状态与标的目录，不含行情或衍生指标。公开可访问的接口和 CORS 响应仅能说明技术访问能力。[东方财富法律声明](https://about.eastmoney.com/home/legal) · [东方财富服务条款](https://corp.eastmoney.com/fuwutiaokuan.html) · [上交所交易规则](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/c_20260424_10816482.shtml) · [深交所交易规则](https://docs.static.szse.cn/www/lawrules/rule/trade/current/W020260424690713155663.pdf)

获得书面许可或换成明确许可的来源后，再审查可用授权条目。条目按 `symbol`、`provider`、`valid_from`、`valid_through`、`evidence`、`scope`、`channels` 记录。v1 需要 `daily_ohlcv_and_indicators_v1` 覆盖自计算起点以来的日线、成交额及衍生指标，并同时允许 `pages` 和 `github_raw_with_history`。GitHub Raw 的旧提交、下载和派生副本可能继续可访问，许可须覆盖公共 Git 历史以及构建产物分发。`evidence` 填可审查的非敏感授权记录编号或链接，别把私密合同或密钥提交到公共仓库。只获单渠道许可时，应另行设计发布范围。代码不会用未经批准的备用源填补失败。

Pages 现有工作流在上海时间工作日 17:20 生成快照并随原站点部署。现有 `main` push 和手动任务同样生成。部署成功后，独立的 `contents: write` 任务校验相同构建产物的提交 SHA 和文件摘要，仅更新 `snapshots-v1` 分支的 `data/v1/`，首次运行创建独立分支，之后追加快照提交。Raw 同步失败时保留前次镜像，由读者按生成时间和过期字段判断，再重跑失败任务。PR 构建只输出状态报告，部署和 Raw 推送均限 `main`。原五面板继续使用原有取数、指标与验证流程，源探测的公开 CI 产物只保留结果报告，原始响应与历史行留在临时 runner 内。

本地只读检查可运行 `python -m stock_analysis.snapshots --validate-live`。它输出来源、日期、行数和日历校验的报告，不输出逐日行情或指标，适合部署前复核。生成策略过滤后的目录可运行 `python -m stock_analysis.snapshots --output work/snapshot-preview/data/v1`。

## 发布后由用户在 ChatGPT 验收

1. 在实际使用的对话里，先只给 Pages `manifest.json` 地址，不贴 JSON 内容。要求直接读取，并原样返回 `schema_version`、`generated_at_utc`、`commit_sha` 及 `sz300078` 的 `status`。若 Pages 打不开，尝试 Raw `manifest.json`，分开记录结果。`publication_blocked` 只证明读取状态成功，不能视为行情验收通过。
2. 有授权行情后，给 `sz300078/latest.json` 地址。要求列出名称、数据源、`as_of_utc`、`last_trade_date`、`expected_session`、`fresh_until_utc`、收盘、`volume_lots`、`MA60`、`RSI14` 和 `ADX14`，同时给出未核实缺口。对照同一发布批次的文件逐项核验。依次对另外三个标的重复，再抽查一条 `history.json` 中早于最近 60 日的记录。
3. 确认读取成功且数据在有效期内后，让 ChatGPT 按价格定位置、均线判趋势、成交量看配合、MACD 看动量变化、RSI 看相对强弱分析，ADX 单独补充。若读取失败、返回空行或已过期，让对话明确说明原因和最后可见日期，避免用模型记忆补数。

2026-11-22 本地实测请求区间为 2025-01-01 至 2026-11-20。四标的均由腾讯返回，分别为 456、456、450、456 行，最后日期均为 2026-11-20。中芯国际标出 6 个已确认停牌日，四标的均无未核实缺口。此为部署前引擎验证。Pages、Raw 新端点和 ChatGPT 对话的端到端读取尚待实测。
