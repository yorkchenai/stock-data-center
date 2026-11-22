# 第三阶段：Pages 候选版本与验收记录

基于 main `11d4b730980074afb5039e6a74a85d9af58ea3d3`，分支 `feat/github-pages`。日期2026-11-22（上海）。本文件区分离线验证、源接口验证和实际 Pages 验证；不把本地通过写成线上通过。

## 方案与参考研究

参考仓库 `hzm0321/real-time-fund` 的 `abbf4f58592b22fab2bd3456de5bc579249e0060`。只研究机制，没有复制实现：

- `app/api/fund.js` 的 `jsonpLoadPingzhongdata` 使用脚本标签读取基金净值全局变量，并设置超时和清理；这不是股票历史日线接口。
- `app/components/MarketIndexAccordion.jsx` 的腾讯 `_var` 接口用于当日分时，不证明多年日线可用。
- `next.config.js` 使用 `output: 'export'`；当前 `.github/workflows/nextjs.yml` 只构建，文件中没有实际 Pages 上传/部署步骤，不能把 README 的部署描述当作接口或部署实测。

本项目候选运行方案使用 HTTPS CORS fetch：东方财富 `push2his.eastmoney.com/api/qt/stock/kline/get` 主源，腾讯 `proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get` 备用。不使用公开代理、不附带凭据、不把密钥放入前端。腾讯 proxy.finance.qq.com 是腾讯自己的接口域名，不是第三方跨域代理。生产页面不执行第三方 JSONP；JSONP/脚本加载只在独立可行性探测中测试。

东方财富使用市场secid（沪1/深0）、日线101、不复权0及明确起止日期。腾讯使用sh/sz代码、day和空复权参数，每两年分段请求，避免单次640行上限。拒绝把qfqday/hfqday作为不复权数据替代。完整历史指用户请求区间内返回的全部记录，不限制120行。

原始腾讯接口中，sh688/sh689股票成交量为股，其余本项目支持的股票/指数为手；成交额字段8为万元。适配器按AkShare1.20.65的现有规则在源入口转换一次。之后canonical volume_lots、VOL5/VOL10均为手，图表不再转换。东方财富数据直接使用手/元。

## 本地实际结果

- Python标准库请求最初对四个验收代码均遇到503；随后同一东方财富接口返回200，科创50共1551条，2020-07-01至2026-11-20，首尾OHLCV及成交额与仓库真实CSV一致。响应含 `Access-Control-Allow-Origin: *`。这证明当次HTTP路径可用，不能证明无间歇故障或Pages可用。
- 腾讯proxy和web两个域名的newfqkline接口均实际返回科创50的2020–2021年486条记录（包括本项目演示起点前的数据），含OHLC、原始成交量及成交额。web域名的脚本响应含允许跨域的头。
- 本机headless Chromium对上述接口的CORS和脚本探测被云代理证书信任问题阻断，错误为 `net::ERR_CERT_AUTHORITY_INVALID`。没有禁用TLS验证，也没有据此把服务判成CORS不支持。
- 当前云代理拒绝 `yorkchenai.github.io`，CONNECT返回403；GitHub Pages配置API的CLI读取也被拒绝。此时无法从这台云机器完成实际Pages验收，不能宣称已上线。
- 43项Python测试通过，14项Node测试通过。全部1551行真实科创50及36组明确标注的人工数值测试序列，逐日对照Python所有19个输出字段（包含涨跌幅）。原始输入要求完全相等，null掩码完全相等，浮点容差 `atol=1e-9, rtol=1e-12`。
- 指标算法保持原Python定义：MA/VOL满窗口均值；EMA首个收盘价初始化、adjust=False；DEA为DIF的EMA9，MACD_hist=2×(DIF−DEA)；RSI在索引period以最初period个价差均值初始化，Wilder递推，平盘为50；DI14在索引14初始化平滑和，ADX14在索引27用第14至27行DX均值初始化。没有用显示区间重新播种指标。
- 本地标准Chromium在1366×768、1440×900、1920×1080及390×844触摸模拟视口通过页面检查：五面板、全历史、显示日期不发请求、显式加载、滚轮/拖动、图例不横向裁切、脚本无运行错误、失败时保留已标注旧数据并显示明确错误。这里行情响应为原始真实科创50数据的受控测试响应，不是在线取数成功证据。截图及结构化报告由CI上传。手机覆盖为Chromium触摸模拟，未完成实体iOS Safari/Android设备验收。

## 校验、缓存与更新

沿用Python XSHG交易日历生成静态日历及已有停牌证据；JavaScript检查数值、OHLC边界、重复/非交易日和请求范围。指数内部缺口触发备用源，仍有缺口则拒绝显示；股票已证实停牌、其他未核实缺口和证据冲突分别报告，不补行。边界缺口可能涉及上市前数据或截断，不能自动判为停牌。股票完整性仍未全面验证。

行情fetch使用no-store，无localStorage/IndexedDB/Service Worker行情缓存。明确加载才向源取数，加载期间禁止重复提交；腾讯分段请求串行执行。没有已知可承诺的供应商频率配额，服务可能限流或更改。存档样本从已有CSV构建，保持原日期并标注“非最新行情”；失败不会静默切换到存档。页面显示实际取数时间、载入起止日期和所有缺口计数。

日历覆盖2000-01-01至构建后31天，最多至当年年底；超出覆盖拒绝请求。工作日UTC09:20重建，GitHub定时执行可能延迟；日历库不支持未来年份时构建明确失败，不推测节假日。

## 工作流与验收层级

`.github/workflows/pages.yml`：

1. build运行离线Python/Node及桌面/手机视口测试，生成相对路径站点，上传pages-review和Pages artifact。
2. live-probe在GitHub runner的本地HTTP来源测试四个代码的完整历史、各源CORS/JSONP，捕获原始源响应，再由原有Python源适配器独立解析并计算指标，逐日对照OHLCV、成交额和全部指标。额外的Python独立HTTP请求分别记录passed或unverified；连接失败不伪装为通过，若取得不同数值则整体验证失败。该来源不是github.io，报告记录实际origin。
3. 只有build与live-probe成功后才允许deploy；PR事件不授予Pages/OIDC写权限、不部署。main及本轮经授权的feat/github-pages分支push可部署，便于不合并main进行审查。
4. deploy成功后，deployed-probe必须在真实 `https://yorkchenai.github.io/stock-data-center/` 来源再次执行四代码取数、页面加载和Python对照，并核对build-info.json提交SHA。只有这一层通过才称为实际Pages取数验收完成。若部署后探测失败，工作流失败且保留报告，不声称部署后的行情可靠；部署本身不会自动回滚。

首次远端运行：[44982624994](https://github.com/yorkchenai/stock-data-center/actions/runs/44982624994)。build成功，live-probe浏览器步骤成功；独立Python HTTP请求因远端断开连接失败，原门槛阻止了deploy。未把此次失败写成通过。之后保留独立HTTP结果，同时增加“实际浏览器原始响应 → 原Python源适配器 → 原Python指标”对照，校验数值不再依赖第二次HTTP连接。

| GitHub runner 本地HTTP来源实测 | CORS | JSONP/脚本 |
| --- | --- | --- |
| 东方财富完整科创50 | 200，1551行；四验收代码均各1551行 | 失败，ERR_EMPTY_RESPONSE |
| 腾讯proxy域名2020–2021 | 200，486行 | 通过，486行 |
| 腾讯web域名2020–2021 | 200，486行 | 通过，486行 |

这不是github.io来源验证。第二次运行44983059629中东方财富CORS也出现ERR_EMPTY_RESPONSE，腾讯分段返回640条向前扩展记录，暴露合并重叠日期问题。本轮已按每段的请求年份裁剪，再合并；段内重复仍拒绝。实际观察：2020段486行，2022/2024/2026段各640行，后者起点分别延伸到2021-05-18、2023-05-17和2024-04-01。裁剪后的真实科创50完整1551行已通过原Python/AkShare源适配器、全部指标及交易日历对照；相关回归测试通过。没有补行或根据重复日期任取一条。

本轮最终远端状态、四代码逐日报告和部署阻碍持续记录在 [PR #3](https://github.com/yorkchenai/stock-data-center/pull/3) 的说明和检查产物中。尚未启用Pages时，目标网址不代表已上线。

## 需要维护者检查的设置

仓库API当前返回 `private=true`、`has_pages=false`，尚未启用Pages。Settings → Pages → Build and deployment → Source选择GitHub Actions。GitHub个人免费账号的私有仓库通常不提供Pages；若设置页要求升级，不购买方案，应先由用户决定是否将仓库公开，或使用已有支持私有仓库Pages的计划。本轮不更改仓库可见性。Settings → Environments → github-pages的分支规则需允许feat/github-pages进行本轮审查部署；若配置了Required reviewers，需要维护者批准部署任务。审查合并后应恢复只允许main，并移除临时分支触发。工作流只需要contents:read，部署job额外pages:write和id-token:write，不需要PAT、数据库或付费资源。

若当前连接不能设置Pages，维护者需完成上述设置，然后重跑工作流；不要直接合并来绕过审查。

## 纯浏览器方案不能稳定工作时的免费替代设计

若真实Pages探测不能稳定取得完整历史，保持此结论为未完成，先审查替代设计：GitHub Actions按显式代码清单定时调用现有Python流水线，校验成功后生成各代码标准JSON/原始CSV及manifest（来源、生成时间、行情截止日期、状态、SHA-256），Pages只同源读取已发布快照。失败任务不能把旧快照标成新数据；每个代码展示过期状态，保留上次成功的清晰时间戳，未收录代码明确提示维护者在Actions输入代码后生成。

该设计没有常驻服务器，指标直接复用Python，不需要移植；代价是网页不能让匿名访客即时获取任意新代码。不能在页面暴露GitHub写token以触发Actions。需要任意代码即时查询时，应先确认一个可靠允许跨域的行情服务，再另行评估后端。本轮不购买资源、不部署付费后端。

JavaScript的engine.mjs不依赖DOM，providers.mjs依赖标准fetch；可作为以后macOS WebView或其他客户端的共享模块，Python继续用于验证和后续研究。
