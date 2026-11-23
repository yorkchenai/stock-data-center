# 场外基金第三阶段验收

## 官方业绩比较基准

| 基金 | 官方基准和适用日期 | 点位或结果 |
| --- | --- | --- |
| 000001 华夏成长 | 原合同无基准。自 2026-07-27 起，中证 800 成长价格指数 `H30355` × 70% ＋ 中债－综合全价（总值）`CBA00203` × 30%。7 月 27 日更新招募说明书规定先算成分日收益、按权重加总、逐日连乘。 | 三季报新基准段为 −4.72%，基金为 −10.93%。复核后，7 月 24 日净值是 7 月 27 日当日收益的前一观察值。近 1、3、5 年均包含无基准时期。 [变更公告](https://static.cninfo.com.cn/finalpage/2026-06-27/1225391047.PDF) · [招募说明书](https://www.chinaamc.com/c/2026-07-27/996946.shtml) · [招募说明书文本](https://m.etf88.com/jjb/2026/0727/9817396.html) |
| 000311 景顺长城沪深 300 指数增强 A | 沪深 300 价格指数 `000300` 收益 × 95% ＋ 1.5% 年收益率按期间折算。2021 年招募说明书及 2025 年报、2026 年三季报均采用此公式。更早时点未在配置中登记。日频建仓口径和固定项的日计数须有进一步证据。 | 中证指数及项目原行情源均有 5 年以上价格日线。保留管理人披露的精确区间值。 [2021 招募说明书](https://m.cgbchina.com.cn/noticeNewDetail.gsp?id=2580980) · [管理人产品页](https://www.igwfmc.com/main/jjcp/product/000311/detail.html) · [2026 三季报（披露文件）](https://doc.morningstar.com/Document/686600828.msdoc/?clientid=chinateam&key=4ceb1f0a7331680c) |
| 110017 易方达增强回报债券 A | 中债总指数（全价），即 `CBA00303`，权重 100%。2020-12-18 合同和 2026 三季报一致。更早时点未登记。 | 已录入管理人披露的同区间基准收益。未取得足以确认代码、日历和可使用范围的完整 `CBA00303` 日线。 [2020 合同](https://cdn.efunds.com.cn/owch/data/notice/20201218/易方达增强回报债券型证券投资基金基金合同.pdf) · [三季报](https://dataclouds.cninfo.com.cn/sjother2/fund/2026/20261027/47a86519db5d2b5d45b254b3a821dc31.pdf) · [全价代码核对](https://static.cninfo.com.cn/finalpage/2026-08-22/1225490988.PDF) |

中证指数官方历史查询对 `000300` 和 `H30355` 均返回 2021-09-28 至 2026-11-20 共 1,246 个交易日，与 XSHG 日历一致。沪深 300 用项目原行情引擎独立核对了交易日期，东方财富及腾讯先后返回同样完整的范围。价格指数和全收益版本独立，债券全价、净价及财富指数也各有定义。数据记录使用实际点位日期，供应商后续更正与数据修订的通知机制尚未独立核实。 [中证指数说明](https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/000300_Index_Methodology_cn.pdf) · [中证 800 成长事实表](https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/H30355factsheet.pdf) · [中债指数查询](https://yield.chinabond.com.cn/cbweb-mn/indices/single_index_query?locale=zh_CN)

## 无风险利率与夏普

| 候选 | 含义与频率 | 取舍 |
| --- | --- | --- |
| 中债国债收益率曲线 3 个月到期收益率 | 人民币短期国债年化收益率，按日披露，可查询历史。中债同时将这一期限用于 SDR 利率的人民币代表性利率。 | 已接入本地可选查询并实测。它在这里作为现金无风险收益的估算代理，实际持有国债回报还受价格和再投资影响。 [中债历史入口](https://yield.chinabond.com.cn/cbweb-cbrc-web/cbrc/showHistory?locale=cn_ZH&mark=1) · [利率说明](https://yield.chinabond.com.cn/cbweb-mn/yield_main?locale=CN) |
| 财政部－中国国债收益率曲线 | 人民币国债市场曲线，包含 3 个月期限，日度更新，历史可回溯至 2006-03-01。 | 独立口径的候选。没有把它的观测拼进中债日序列。 [财政部曲线说明](https://yield.chinabond.com.cn/cbweb-czb-web/czb/bzcxsmDown?locale=cn_ZH) |
| CFETS 国债收盘收益率曲线 | 银行间市场每日收盘估值，同为人民币主权收益率。当前官方期限表从 6 个月开始。 | 可用于不同期限的对照。数据产品的下载与使用条件需另核。 [CFETS 方法](https://www.chinamoney.com.cn/english/bmkycvcyc/) |
| IMF SDR 利率计算的人民币成分 | 使用中债 3 个月国债代表性利率，按周公布当周计算表。 | 可核对某些周的市场报价。SDR 综合利率包含其他货币。 [IMF 每周计算表](https://www.imf.org/EXTERNAL/NP/FIN/DATA/sdr_ir.aspx) |

对从上一笔确认净值日到本次净值日的每个观察期，取上一观察日或之前最近的可用中债报价。年化百分比转为小数后，本项目采用单利 ACT/365F，期收益为 `年化报价 × 实际自然日数 / 365`。周末和节假日计入持有自然日。报价日距离观察起点最多 10 天。独立 XSHG 日历用于检查该区间内应至少存在的报价日，遇缺口或超出实际报价覆盖时夏普为空。适用复利年报价的获准文件可声明 `effective_act_365f`，利率换算为 `(1 + 年利率)^(自然日数/365) − 1`。旧版固定利率文件继续按 252 个观察日复利等效换算。

夏普为 `mean(基金观察期总回报 − 同期无风险收益) / sampleStd(同一组超额收益) × √252`，样本标准差分母为 `n−1`。基金的年化波动率继续使用基金日收益本身的样本标准差。没有两个有效样本、存在净值长缺口、超额波动为零、或利率覆盖不足时，夏普保留空值和原因。索提诺仍沿用原有 0% 的明确计算目标。

## 本地导入与字段

在本地个人使用许可允许时运行以下命令。数据仅写入本地新文件，然后在场外基金详情页导入。查询超时可先生成含净值和官方披露的 JSON，再导入已授权的利率文件。

```bash
python -m stock_analysis.funds 110017 --risk-free-start 2021-09-28 --output work/fund-110017.json
python -m stock_analysis.funds 110017 --benchmark-data work/110017-benchmark.json --risk-free-data work/rmb-3m.json --output work/fund-110017-enriched.json
```

- `benchmark` 的 `official`、`name`、`source` 保持兼容，可以补充 `source_url`、`formula` 和 `regimes`。每段用 `effective_from`、可选 `effective_to`、`source` 与 `method` 描述适用公式，公式适用到每笔收益的结束日。成分含 `id`、`weight`、`basis`，区分 `price`、`total_return`、`full_price`、`net_price`。`none` 表示官方明确无基准，`unverified` 表示计算口径还待核对。
- `--benchmark-data` 接收 `{code, series}` 或 `{code, official_levels}`。成分序列每项提供 `id`、`basis`、`source`、`rows: [{date,value}]`，建议附 `source_url`、`retrieved_at`、`data_date`。可附 `calendar: {from,to,source,sessions}`。只有已知该市场休市可沿用上一笔实际点位。缺少开市点位时截断基准线。管理人公布的已算基准点位可用 `official_levels: {source,source_url,retrieved_at,rows}`。成分与净值采用相同的实际起止日，首点归零。
- `daily_weighted` 逐日连乘，`period_weighted` 按各成分从该制度区间起点的累计收益加权。跨制度时按已核验的制度边界衔接。两种口径分别验收。`disclosed_periods` 含 `start`、`end`、`return` 和 `source`。只在日期完全一致时，可用其计算百分点超额。没有日频点位时保持曲线空白。
- `risk_free` 可附 `source_url`、`retrieved_at`、`data_date`、`quote_basis`、`status` 和 `missing_dates`。历史模式需要 `name`、`source`、`effective_from`、`effective_to`、`max_age_days`、`convention` 与 `rows: [{date,annual_rate}]`。利率用小数，日期按 ISO 格式递增。缺失或过期由实际选中区间判断。通过 `--nav-csv` 导入时，仅对已核实为日频的净值文件显式使用 `--daily-nav`。
- 完整历史的许可和浏览可达性分别核验。中债页面对未经允许的转载设限，中证及中债的专业历史产品各有授权渠道。本项目资料只记录官方公式、少量已发布的区间摘要和验收统计。完整点位、净值、利率序列和凭证不进仓库、站点或 CI 附件。 [中债声明](https://yield.chinabond.com.cn/cbweb-mn/yield_main?locale=zh_cN) · [中证官方历史数据渠道](https://www.ciis.com.hk/hongkong/sc/historicaldata1/index.shtml)

## 真实数据交叉核验

管理人三季报基准期末为 **2026-09-30**。近 1、3、5 年对应实际净值起点分别为 2025-09-30、2023-09-28 和 2021-09-30。基金收益由既有总回报引擎独立计算。夏普按近 1、3、5 年顺序，使用上文同一口径的历史中债利率。

| 基金 | 基准收益率，1 / 3 / 5 年 | 超额，百分点 | 夏普 |
| --- | --- | --- | --- |
| 000001 | — / — / — | — / — / — | 0.379 / 0.516 / 0.046 |
| 000311 | −4.32% / 22.75% / −2.65% | +7.24 / +7.44 / −0.39 | 0.186 / 0.530 / −0.055 |
| 110017 | 0.90% / 4.90% / 6.80% | +2.39 / +13.14 / +15.84 | 1.038 / 1.658 / 0.949 |

110017 近 5 年基于实际净值的收益为 22.6431%，管理人表列 22.65%、15.85 个百分点。差异约 0.007 个百分点，记录原始结果。华夏成立后首次基准段用自定义 2026-07-24 至 2026-09-30 得到 −6.21 个百分点。晚于报告期末的统计区间不会沿用已披露的区间收益。

中债历史报价在 runner 实际返回 2021-09-18 至 2026-11-20 的 1,289 条观察值，含预留起始报价。网页和独立 Python 夏普计算对三只基金在报告期末和最新净值日的 1、3、5 年区间逐项比较，精度阈值为 `1e-11`。Python 使用二分查找和 `statistics.stdev`，Node 走实际网页模块。 [首次真实夏普复核](https://github.com/yorkchenai/stock-data-center/actions/runs/45135233792)

## 回归和后续

浏览器自动化测试覆盖 1440×900 和 390×844 双视口的基金卡片、基准完整与部分状态、日期选择和风险数据缺失。既有科创 50 历史五面板继续在四种视口回归。GitHub PR 构建生成临时 Pages 产物供测试，无生产部署。下一步优先取得可使用的 `CBA00303` 全价历史及对应发布日历，与官方三季报同窗口检验后启用 110017 日频基准线。向景顺长城核实 1.5% 期间折算的日计数及复利方法。
