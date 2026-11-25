# 关联板块指数成交量 · 第八阶段补充

东方财富及授权 API 的后续调查见[替代数据源验收](off-market-funds-volume-sources.md)。

## 最终核验

2026-11-24 核验结论为 **0/24 条达到 A 级**。中证白酒、全指通信、全指医药为 B 级。其余 21 条已有原始字段覆盖，缺少各自的同日单位或字段映射证据，按 C 级待核实。真实成交量和 VOL 继续使用现有空状态。

### CIIS 正式字段及样本

CIIS《Historical Data Product Manual》v20260819 第 6.5.1 节将 CSI Snapshot 股票指数 `Volume` 的单位列为股。该节的 `Amount` 单位是万元。第 6.5.2 节在 `CSI/Day/<Date>/Day.csv` 列出 `SecurityID`、交易日 `DateTime`、`Volume` 和 `Amount`，未单列该日线表的成交量与成交额单位，也未引用中证网页 `index-perf`。这是一条明确的同编制机构快照单位证据。快照、日线文件和网页三者仍需同代码、同交易日比对。[CIIS 手册，第 6.5.1–6.5.2 节](https://www.ciis.com.hk/hongkong/tc/uploadfiles/202608/24/2026082405074912924005.pdf)

CIIS 公开目录列有 `20221206_Sample_CSI_Day.xlsx`。本轮用默认 HTTPS 验证尝试英、简、繁三个官方目录，工作区代理均返回 403，云端桌面的浏览器控制也未加载目录。前轮 GitHub runner 在请求官方目录时报告 `SSLCertVerificationError`。样本工作簿未取得，实际代码、日期、表头和数值均未读取。下表中的 2022-12-06 是已留存的外部对照日期，样本文件名仅提示可优先检查该日。[官方样本目录](https://www.ciis.com.hk/hongkong/en/historicaldata1/sampledata/index.shtml) · [前轮样本请求日志摘要](https://github.com/yorkchenai/stock-data-center/actions/runs/45318406464/artifacts/14886198171)

### 同日字段对照与分级

用前次留存的 7 组记录离线复算。每组的指数代码、交易日及 OHLC 一致。最大绝对差为 31 股和 354,440 元，均在东方财富整数手及中证网页两位小数亿元所对应的半个舍入单位内。差值按网页 `tradingVol − f56 × 100` 计算。对照文件中的 `f56` 单位依据是东方财富指数 K 线适配文档。CIIS 样本列为空意味着正式日线映射未核验。[七组原始对照与方法](https://github.com/yorkchenai/stock-data-center/actions/runs/45317731769/artifacts/14886641565) · [东方财富指数 K 线适配字段](https://github.com/akfamily/akshare/blob/main/docs/data/index/index.md#历史行情数据-通用)

| 指数 | 交易日 | 网页 `tradingVol` | 东方财富 `f56`（手） | 按股计的差值 | CIIS 日线 `Volume` |
| --- | --- | ---: | ---: | ---: | --- |
| 399997 | 2022-12-06 | 299,347,876 | 2,993,479 | −24 | 未取得 |
| 399997 | 2024-06-28 | 128,378,003 | 1,283,780 | 3 | 未取得 |
| 399997 | 2026-11-23 | 186,420,722 | 1,864,207 | 22 | 未取得 |
| 000994 | 2022-12-06 | 4,996,620,431 | 49,966,204 | 31 | 未取得 |
| 000994 | 2024-06-28 | 2,228,822,376 | 22,288,224 | −24 | 未取得 |
| 000994 | 2026-11-23 | 3,272,754,026 | 32,727,540 | 26 | 未取得 |
| 000991 | 2022-12-06 | 5,287,026,400 | 52,870,264 | 0 | 未取得 |

| 指数 | 等级 | 单位判断及剩余证据 |
| --- | --- | --- |
| 399997 中证白酒 | B | 三日支持按股解释。样本是与白酒生产业务相关的上市证券，日线字段映射、成交范围和许可待确认。 |
| 000994 中证全指通信服务 | B | 三日支持按股解释。官方 2026-10-30 单张显示上海、深圳通信服务样本，日线字段映射、成交范围和许可待确认。 |
| 000991 中证全指医药卫生 | B | 仅一日精确对上 100 倍，其他两日对照请求断连。官方同期单张显示上海、深圳、北京医药卫生样本，日线字段映射、成交范围和许可待确认。 |
| 其余 21 条 | C | 有原始字段，缺少本轮所需的逐指数单位或同日映射证据。 |

三只指数的样本证券集合和交易所分布有差异。现有资料未说明网页累计量是否按相同规则纳入盘后、大宗和各交易所交易，历史口径是否变更也未确认。股换算成手在数学上是乘 `0.01`，保留小数即可复核。只有相应指数和历史区间的来源单位、统计口径及用途均确认后，才可按现有合同用于特定获准展示模式。[399997 编制方案](https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/20231208175434-399997_Index_Methodology_cn.pdf) · [000994 指数单张](https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/000994factsheet.pdf) · [000991 指数单张](https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/000991factsheet.pdf)

### 按用途核查授权

CIIS 当前下载目录列出 2026-01-01 修订的《上交所和中国指数市场行情政策和指引》。第 4 节免批核的日终行情指香港时间午夜后转发、每天至多更新一次的开高低收数据，条文未列成交量或 VOL。第 5 节规定，经 CIIS 书面同意的直连信息商可在订户获预批并完成订购后向其转发历史数据，限内部使用。该文本未给本项目从中证公开网页自动取数和展示的许可。[CIIS 当前文件目录](https://www.ciis.com.hk/hongkong/en/productsandservices/documentdownloads/index.shtml) · [2026-01-01 版，第 4–5 节](https://www.ciis.com.hk/hongkong/sc/uploadfiles/202601/09/2026010917282255474308.pdf)

| 用途 | 核验结果 |
| --- | --- |
| 个人本地查询与绘图 | 正式历史产品有内部使用订购渠道。网页接口自动读取历史成交量、个人本地绘图的许可尚未确认。 |
| 本地缓存历史数据 | 手册提及交付平台的下载和留存窗口。未取得网页历史数据的本地缓存期限、长期留存或更新授权。 |
| 公开网站展示每日成交量及 VOL | 日终价格免批核条款未明确覆盖这两项。原始成交量展示和可反映成交量的派生指标都需要适用许可。 |
| 公共仓库分发完整历史 | 内部使用条件未授予公开发布或再分发权限，本项目也未取得单独授权。 |

可向 CIIS (`hd@ciis.com.hk`) 或中证 (`csindex@sse.com.cn`) 核对三项：代表性同日记录及 `tradingVol` 字段与正式产品的对应关系，各指数含盘后和大宗的统计规则及历史变更，所需展示模式的书面许可和缓存期限。获得样本后，以工作簿实际 `SecurityID` 和 `DateTime` 定位匹配行，逐条比对 `Volume` 与网页原值并记录单位、差值和是否舍入。样本覆盖不到的指数仍需逐只求证。[CIIS 历史数据产品](https://www.ciis.com.hk/hongkong/en/historicaldata1/his_introduction/index.shtml)

## 字段依据和许可

中证指数官网的 `index-perf` 日频响应分别提供 `tradingVol` 与 `tradingValue`。2026-11-24 实测访问中证白酒详情页，页面能看到「成交量」，公开资料仍缺少该网页日频 JSON 字段的单位和成分证券统计边界。`tradingValue` 在核对中保留原值，成交额无需参与 VOL 计算。[中证白酒详情页](https://www.csindex.com.cn/#/indices/family/detail?indexCode=399997) · [中证日线接口示例](https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=399997&startDate=20261123&endDate=20261123)

上交所 `MD001` 数据规范可核实：`TradeVolume` 是参与指数计算的成交数量，股票指数以 100 股计，基金指数以 100 份计，债券指数以千元面额计。第 3.11 节另把中证指数通文件指向中证自己的传输规范。上述规定的适用范围是相应行情文件，网页 `tradingVol` 的映射仍需核实。[上交所市场数据文件交换接口规格书 3.540](https://www.sse.com.cn/services/tradingtech/development/c/10822594/files/2096257019bf484f9b9935fa73f94721.pdf)

CIIS 的日终中证产品将 Trade Volume 与 Trade Amount 分列，并提供产品说明、样本及订购渠道。公开目录列有 `20221206_Sample_CSI_Day.xlsx`，但实测取得文件的 HTTPS 路径因证书校验失败而未完成。东财掘金列出三个同代码品种。Tushare 指数日线有独立文档，实测未配置授权 Token。AKShare 的中证适配器访问同一个上游，东方财富指数适配器则将同日 K 线的成交量标为手、成交额标为元。对账直接查询后者的原始字段，以便保留身份和日期证据。[CIIS 产品条款与联系渠道](https://www.ciis.com.hk/hongkong/en/historicaldata1/his_introduction/index.shtml) · [CIIS 公开样本](https://www.ciis.com.hk/hongkong/en/historicaldata1/sampledata/index.shtml) · [东财掘金指数目录](https://emt.18.cn/api/quant-help/data/indices.html) · [Tushare 指数日线](https://tushare.pro/document/2?doc_id=76) · [AKShare 东财指数行情数据字段](https://github.com/akfamily/akshare/blob/main/docs/data/index/index.md#历史行情数据-通用) · [AKShare 中证适配器](https://github.com/akfamily/akshare/blob/main/akshare/index/index_stock_zh_csindex.py)

已做限速、逐日的小样本研究核验。网页可访问性与自动取得、持续使用、衍生指标展示及再分发分别需要依据。本次没有注册任何可启用真实成交量的中证指数。日线和对照源原始历史在内存处理，审查产物仅保留覆盖统计、少量单日样本和用户要求的界面截图。若向 CIIS（`hd@ciis.com.hk`）或中证确认，需索取这三个代码的 `tradingVol` / `tradingValue` 字段定义、样本纳入范围、历史变更和零值含义，以及个人本地自动查询、储存及展示的书面条件。[中证历史行情许可产品](https://www.ciis.com.hk/hongkong/sc/historicaldata1/his_introduction/index.shtml)

## 三条核心指数

覆盖扫描取数自 2021-01-04，2026-11-24 盘中的最新完整日线是 2026-11-23。三条核心指数均取得 1,426 日 OHLC 和有效原始成交量字段，内部无开市日缺口。以下数值保持原始口径。`—` 代表正式数据合同下尚不可计算。

| 指数 | 日期 | `tradingVol` | `tradingValue` | 原始单位 | 标准化成交量 | 独立来源核验 | VOL5 | VOL10 |
| --- | --- | ---: | ---: | --- | --- | --- | --- | --- |
| 399997 | 2022-12-06 | 299,347,876 | 332.66 | 股，抽样推断 | — | 东财 2,993,479 手 | — | — |
| 399997 | 2024-06-28 | 128,378,003 | 139.97 | 股，抽样推断 | — | 东财 1,283,780 手 | — | — |
| 399997 | 2026-11-23 | 186,420,722 | 138.70 | 股，抽样推断 | — | 东财 1,864,207 手，英为财情原始量相同 | — | — |
| 000994 | 2022-12-06 | 4,996,620,431 | 439.23 | 股，抽样推断 | — | 东财 49,966,204 手 | — | — |
| 000994 | 2024-06-28 | 2,228,822,376 | 331.50 | 股，抽样推断 | — | 东财 22,288,224 手 | — | — |
| 000994 | 2026-11-23 | 3,272,754,026 | 1,139.84 | 股，抽样推断 | — | 东财 32,727,540 手 | — | — |
| 000991 | 2022-12-06 | 5,287,026,400 | 1,065.51 | 股，抽样推断 | — | 东财 52,870,264 手 | — | — |
| 000991 | 2024-06-28 | 1,030,990,700 | 236.72 | 当日待核实 | — | 该轮东财请求断开 | — | — |
| 000991 | 2026-11-23 | 1,538,177,600 | 430.38 | 当日待核实 | — | 该轮东财请求断开 | — | — |

成功读取东财的 7 个日期，指数身份、日期和四价一致。东财 `f56` 乘以 100 与中证 `tradingVol` 相差不超过 50 股。中证 `tradingValue` 乘以一亿元后与东财 `f57` 的差不超过两位小数亿元对应的半个舍入单位。三个代码的实测样本支持「股、亿元」的解释。历史字段定义、成分证券的纳入范围和使用许可仍待确认，禁止按该解释自动启用成交量。东财仅作对照，未作为运行时备源。[双源逐日审计与三条核心指数覆盖](https://github.com/yorkchenai/stock-data-center/actions/runs/45317731769/artifacts/14886641565) · [东方财富法律声明](https://about.eastmoney.com/home/legal)

英为财情的中证白酒 `CSI399997` 在 2026-11-23 的收盘点位和精确原始成交量与中证一致。其开盘 6,605.38、最高 6,670.61，有别于中证 6,607.46、6,670.67。该对照的作用是确认该日期公开页面的数值关系，单位和独立上游仍未确定。[英为财情中证白酒历史页面](https://cn.investing.com/indices/csi-liquor-historical-data)

## 24 条候选指数

| 整段覆盖分类 | 数量 | 指数代码 |
| --- | ---: | --- |
| 全段完整日K，无可展示成交量 | 16 | 000300、000905、000852、000986、000987、000988、000989、000990、000991、000993、000994、000995、399997、399975、930713、H30535 |
| 部分日期有完整日K，无可展示成交量 | 2 | 932075、932076，各有 897/1,426 日 OHLC |
| 只有可靠收盘价，无可展示成交量 | 6 | 932112、932116、932118、932131、932133、932139，各有 1,185 日收盘和 241 个内部开市日缺口 |
| 行情未取得 | 0 | — |
| 单位、口径及用途均已核验，可展示成交量和 VOL | 0 | — |

24/24 取得至少一个非负原始 `tradingVol`，18/24 有至少一个完整 OHLC。24/24 尚无可用于图表的可信成交量，其中 0 条完全缺少原始成交量字段。不能把部分历史有 OHLC 的两条指数计作全段完整日K。复跑和逐只报告保存在 [真实数据审查工作流](https://github.com/yorkchenai/stock-data-center/actions/workflows/fund-chart-review.yml)。

## 成交量字段合同

既有 `volume`、`VOL5`、`VOL10`、`volume_unit` 和 `source.volume_unit_evidence` 保留。启用成交量时，`source.volume` 同时记录 `raw_unit`、`raw_field`、`conversion_factor`、`scope: index_constituents` 和 `permission: authorized_local_use`。`volume_unit_evidence` 指向经核实的 HTTPS 依据。换算系数定义为原始数值乘以系数后得到展示单位数值。API 只换算一次，前端原样读取归一后的 `volume`、`VOL5` 和 `VOL10`。显示单位核对股、手、份，以及各自支持的数量级。成分汇总用途与单位证据须在接入前审核，前端合同检查不能替代这一步。

来源、用途、单位或系数不合格时，拒绝成交量但保留合法 OHLC。`quality.volume_status` 区分 `available`、`unit_unverified`、`invalid_provenance` 和 `missing`，`volume_coverage` 记录原始字段起止日、缺失交易日、空字段、无效值和零值计数。缺少成交量时保持空值。零保留为实测值，来源若用零代表缺失需另行做来源适配。开市日历由后端补出空行，VOL5/10 只对完整的 5/10 个连续开市日取算术平均，切换显示范围不改变已计算的预热。图表以 7:3 上下窗格共用时间轴，独立控制三条量能序列，跨缺口断线。

真实浏览器验收重跑三只基金及一条只提供收盘价的指数，检查桌面和模拟手机视口、日K及均线、日期和光标、切换基金与板块、缺失量降级。带明确单位的合成合同另外覆盖共享光标、VOL 预热、零值、负值、缺失交易日、单位及换算校验。真实验收的通过数为 0 条成交量与 VOL 序列。[桌面和手机真实截图及观测](https://github.com/yorkchenai/stock-data-center/actions/runs/45317731769/artifacts/14885459347)
