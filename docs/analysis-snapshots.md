# Analysis Snapshot 隔离验收

## 长期架构审计

截至 2026-11-25，正式私有 Worker 第 13 版通过现有插件 1.0.4 提供股票、基金和详情查询。PR #5 中的 Pages 按快照读取和故障回退已经可以在隔离环境运行。生产 Pages 的构建未配置共享 Worker 地址，正式私有 Worker 只路由 MCP，因此线上网页与 Live 的同 ID 一致性仍待验证。

| 范围 | 审计发现 | 最小改造 |
| --- | --- | --- |
| 唯一计算来源 | 股票指标、基金净值与绩效、关联模型的 JS 文件在正式 Worker 和 PR #5 一致。正式部署曾手工复制运行时，接口和展示代码已经产生差异。Python 仍用于本地与独立复算。 | 从现有分支的一次构建生成隔离 Worker 运行时和 Pages 文件，两者共用同一版本与输入。保留生产网关、限流和连通性工具的轻量外层。 |
| 基金网页 | 固定风险区间和关联排名从快照读取。基金列表原先会重新计算周期收益，自定义区间会用网页同版引擎计算。完整排名有 24 个候选指数输入，图表按需读取入选指数。 | 固定区间收益和风险直接展示快照结果及原统计日期。先在仅所有者可访问的测试环境验收固定 ID，再评估自定义区间是否需要 Worker 查询。 |
| 股票网页 | 隔离页面可完整读取同 ID 的行情和指标；线上股票页面仍独立取数。网页显式历史起点与 MCP 固定计算起点可能产生不同快照，尤其会影响递推指标。 | 先验收基金。股票后续只在同一标的、日期窗口和计算起点时复用快照。保留网页历史范围、图表和独立回退。 |
| 版本与扩展 | D1 已按模型版本和查询条件缓存。页面会拒绝不同版本，防止自定义区间串用模型。MCP 已有通用 `model` 类别，基金当前只返回基准、风险周期和关联状态等元数据。 | 新模型由统一引擎写入有版本、数据口径和状态的输出，按经允许的模块读取。不新增每个指标专用工具。保留旧版本的读取规则，避免把旧结果标成新计算。 |

构建以计算模块、数据解析、日历和实际使用的基金配置生成 `model_version`。构建时间、配置生成日期和只影响接口展示的代码变更不会单独触发重算。兼容性由 `schema_version` 单独判断。任何新模型依赖或计算规则须纳入版本计算。生产发布前需保留第 13 版保存版本及插件 1.0.4 发布记录，确认能使用原绑定回滚。

生产 Pages 当前仍由浏览器独立取数。股票、基金的私有同快照验收已完成。公开方案沿用同一个快照服务，浏览器不带凭证。快照 ID 用于定位。CORS 只限制浏览器读取来源。

### 基金私有联调

同源测试页面使用 Sites 所有者登录会话，私有读取路由只接受三只批准的基金和其固定 ID，和 MCP 共用隔离 D1。网页路由单独以 60 次/分钟限流，不接受强制刷新、跨站 Origin 或额外查询参数，不返回 CORS 许可。页面默认的独立查询回退保留。固定 ID 下载或查看失败时报告原因。

之前的 runner 在 932133 已收到 HTTP 200 后发生超时，未记录 932139 和 H30535 的后续请求。三只指数都有先前私有实盘报告可核对。它们未映射到股票行情适配器，当前只有中证官方网的同指数数据源可用。特殊指数先按独立超时预算请求一遍，允许单次超时后继续请求下一只，有全局预算时再对超时指数重试一次。HTTP 401、403、429 不重试，也不以近似指数替代。请求状态与模型有效覆盖分开报告，原有 120 日阈值不变。

### 股票私有联调

私有网页和 MCP 的快照统一从 2025-01-01 取数并预热。相同股票及最后完整交易日共用快照 ID，较晚的开始日期只截取已计算结果。不同结束日期各有独立 ID，重叠日期仍采用同一预热起点。指定日期早于共享起点时，网页可独立取原有历史，并明确标示独立来源和计算起点。已固定的快照失败时直接报告，不替换成独立行情。

仅允许已登录所有者通过私有同源路由读取 300078 和 600519。网页配额与 MCP 分开。验收对照开高低收、成交量与成交额，另逐日比较 MA、VOL、EMA、MACD、RSI、ADX 和 DI，以及同一 20 个完整交易日窗口的高低价和日期。

同一个 `snapshot_id` 绑定标的、原始输入、模型版本、计算时间与结果。股票快照调用现有 `web/providers.mjs` 和 `web/engine.mjs`。基金复用已有净值解析、`performance.mjs`、`sector-model.mjs` 和 `sector-browser.mjs`。常用区间的风险和收益点序列在写入前计算。基金累计净值与总回报保持独立，覆盖不足或缺少无风险利率时保留缺失原因。指数与基金日期各自记录。

## 读取与更新

- MCP 第一问仍用 `get_stock_analysis` 或 `get_fund_analysis`。向后兼容的摘要另附 `snapshot_id`、数据日期和模型版本。Worker 内等待超过 7 秒时返回 `building` 并用 `waitUntil` 继续运行。客户端实际等待还受网关耗时影响。语音工具说明最多自动续查一次，再等待用户追问。若返回 `after_snapshot_id`，续查保留同一组参数、带回该字段并省略 `refresh`。续查不会启动另一轮取数，刷新失败会明确返回。
- `get_analysis_details` 接收 `asset_type`、`symbol`、`snapshot_id` 和 `category`。历史与指标支持指定日期、最近 1–120 条、区间分页及指定字段最大最小值。风险支持常用区间，关联分析可按指数代码读取模型和对应日期。
- D1 每次从主库启动独立会话。快照头及压缩分片在一个事务中插入，提交后才返回 ID。每个分片上限 450,000 字节，每个快照至多 12 个分片，原始序列整体上限 20 MB，单次 JSON 响应上限 4 MB。持续时间最长 45 秒的数据库锁防止多个 Worker 重复构建同一代码、日期和模型版本。
- 股票默认从 2025-01-01 计算，保留指定历史计算起点。当前窗口完整快照最多保留 4 小时有效期，并且不会跨过下一次预期收盘行情发布；历史窗口 24 小时。基金完整快照有效 30 分钟，部分结果 10 分钟。冷启动停留在 `building` 时可按同一代码查询，不传 `refresh`。显式刷新生成新 ID，旧 ID 到原定更新时间前仍可读取。过期内容不可作为当前数据提供，物理清理保留时间为过期后 7 天，并在之后的成功写入时批量执行。
- 计算版本哈希包含分析源码、日历、基金事件及基准和指数配置。升级后默认查询仅使用当前版本，旧 ID 在有效期内仍返回原版本。页面按快照读取常用区间成果，并在模型版本一致时用同一套函数计算用户自选区间。

## 隔离运行

以下命令生成本地 Pages 预览，只启动回环 HTTP 和隔离的 workerd，不修改生产服务。运行环境需 Python 项目依赖、Node 24 及 Chromium。

```sh
npm ci --ignore-scripts
npm install --prefix /tmp/analysis-snapshot-tools --no-save esbuild@0.28.1 miniflare@4.20260730.0
python -m stock_analysis.pages --output work/snapshot-stage-pages \
    --snapshot-service http://127.0.0.1:8787 --snapshot-runtime-output work/snapshot-stage-runtime
node scripts/test_snapshot_stage.mjs --fixture
node scripts/test_snapshot_stage.mjs
```

普通构建省略两个快照参数，继续使用浏览器独立模式。独立 Worker 目录仅包含模块和构建配置，和 Pages 分开输出。隔离测试直接加载该目录并核对两端配置字节一致。隔离浏览器可打开 `index.html?symbol=300078&snapshot_id=…` 或 `funds.html?fund=110022&snapshot_id=…`。显式指定 ID 查不到时页面显示错误，可通过普通查询继续。普通查询最多给快照 11 秒，最多发起 3 次初次查询请求。来源故障、编号或标的不一致、快照过期、模型版本不匹配、股票尾部缺失及基金共享指数少于已验证的 14 条时，执行对应的整套浏览器分析。页面展示独立来源、日期、版本及回退原因。共享模式从快照读取固定区间收益及风险数据，自定义区间只对同版本的快照输入运行同一套函数。

## 第 10 版兼容性

| 调用面 | 保留的字段与行为 |
| --- | --- |
| 股票首次结构化结果 | 原 `source` 字符串、`status`、`requested_start/end`、固定计算起点、日线日期、单位、质量字段及 `more/next_end` 保留。默认 60 条，显式日期请求最多 120 条。显式起点只改变返回切片。 |
| 基金首次结构化结果 | 原 `source` 对象、`freshness`、近 1 月/3 月/1 年收益、最大回撤和起止日期、关联指数排名及指数交易日继续可用。基金缺少利率或其他输入时 `snapshot_status` 保持 `partial`，旧 `status` 亦标记为 `partial`。 |
| 语音与详情 | 语音文本省略股票日线数组，结构化对象保留旧分页。`snapshot_status`、`snapshot_id`、`model_version`、`data_as_of`、`cache` 等为增量字段。详情读取固定 ID 和现有 D1 内容。 |

正式入口接入时保留现有 Site、插件、网关注入的所有者鉴权、旧限流表及原 `stock_voice_probe` 路由。隔离快照包提供两个雷达及详情工具，生产入口还需单独配好宿主网关和原有兼容路由。第 13 版私有插件已完成 iPhone Live 验收。

## 私有线上复算和日志

现有测试站点的验收页可下载同一 ID 的所有者复算档案。档案保留真实日期及缺失状态，过期档案只用于历史核验。请在获准的个人环境使用，与同一测试部署的日历配置配对。复算输出只列差值、计数、排名和缺失原因。

```sh
python -m scripts.audit_hosted_snapshot --calendar path/to/calendar.json \
  --config path/to/fund-config.json path/to/snapshot-audit.json
```

验收页的 `request_id` 对应 Worker 的 `snapshot_request`、`snapshot_hit`、`snapshot_read` 等事件。冷构建的 `snapshot_upstream` 及 `snapshot_publish` 共享初始请求编号。日志分别记录上游请求个数、构建、写入和 D1 读取及解码时间。详情日志可确认 D1 固定 ID 读取及零回源。基金关联指数仍保留逐条实际覆盖状态，无风险利率缺失时保留夏普空值。

## 权限和上线边界

快照存储使用现有 D1 类型与绑定，不需要 KV。KV 在跨地区通常为最终一致，新 ID 的立即读取受其全局传播限制。生产 D1 迁移须在获得发布授权后对原有绑定执行。Cloudflare D1 免费方案的公开限额包括每库 500 MB、账户 5 GB 以及每账户每日 10 万行写入和 500 万行读取。实际容量取决于压缩率、标的数和刷新频率，平台另外按请求和数据库操作设限。[D1 限额](https://developers.cloudflare.com/d1/platform/limits/) · [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/) · [KV 一致性](https://developers.cloudflare.com/kv/concepts/how-kv-works/) · [D1 Sessions API](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession)

### 免登录网页入口

`GET /api/analysis` 与私有 MCP 共用 `analysisService`、D1 主库和版本化缓存键。公开入口默认关闭。上线时才设置 `SNAPSHOT_PUBLIC_ENABLED=1`、`SNAPSHOT_PUBLIC_ORIGIN`（准确的 Pages 来源，如 `https://yorkchenai.github.io`）。可用 `SNAPSHOT_PUBLIC_SYMBOLS` 收窄试运行标的。浏览器从配置的来源访问，无需账户或 Cookie；没有 `Origin` 的客户端也能访问受相同限制的公开 GET。已有私有测试路径仍使用所有者鉴权。

公开 GET 仅接收单个标的、当前完整股票交易日或最新确认基金数据的按需构建，以及按 ID 读取当前模型版本的 `page` 或基金关联指数 `index` 视图。网页可缩短显示范围。较早的股票查询仍可走已有网页独立取数，并注明计算版本和来源。已打开的固定 ID 过期或版本变化时显示错误。公开路由拒绝重复或未知参数、刷新、批量查询、自由历史导出和非 GET 方法。查询字符串上限 512 字符，保留原有 4 MB 响应上限。

匿名查询直接读取快照或按缓存键构建。不同缓存键可以并行，同一缓存键仍由 D1 锁合并。公开查询无应用层频率额度，继续受 Cloudflare 平台配额、处理上限和上游超时约束。MCP 及隔离私有接口保留原配额。既有 D1 表结构无需迁移，旧的公开计数行可以留存。D1 凭证和 MCP 配置留在 Worker。

### 数据公开范围与授权风险

已取消项目自设的 `SNAPSHOT_PUBLIC_DISPLAY_GRANTS` 来源许可白名单和相应的运行时硬拦截。匿名接口仍须显式设置 `SNAPSHOT_PUBLIC_ENABLED=1` 才开放，且仅提供受限的当前单标的查询及指定 ID 的 `page` / `index` 视图，不支持自由导出历史、强制刷新或管理操作。基金匿名视图保留业绩基准名称和出处及已计算的风险指标，省略无风险利率输入、业绩基准历史和风险模型内的基准曲线。公开接口仍保留响应大小、配额、并发与来源边界限制。取消程序限制**不代表任何数据来源已授权公开再分发**，也不代表已完成法律或合同合规评估。

东方财富声明要求行情信息的复制、传播或演示取得相关交易所事先书面同意。天天基金公示页面标注 Choice 数据；未取得该净值历史由项目服务器公开分发的许可。腾讯历史日线端点也未找到适用于本项目的公开再分发授权。CIIS 所列的有限日终四价转发条件不能覆盖项目拟公开的完整历史及成交量。价格和净值图、量额和派生指标、关联排名与指数图应分别核实许可，包含服务器缓存期限。供应商页面可读、CORS 通过或公开提供下载均不能证明获准再分发。 [东方财富法律声明](https://about.eastmoney.com/home/legal) · [天天基金净值](https://fund.eastmoney.com/fund.html) · [CIIS 许可核对记录](off-market-funds-volume.md#按用途核查授权)

### 正式网关与配对发布

现有生产 Site 使用整站的所有者访问策略，外部请求在进入 Worker 前受此策略约束。Sites 支持整站公共模式，平台仍认证 `/mcp` 并注入已认证身份。按当前可见配置，没有单路径免登录例外。最小方案是在同一个 Site 的正式 Worker 中安装 `mountSnapshotSite`，用 Sites 验证的现有所有者邮箱保护 `/mcp` 和诊断首页，其他应用路径返回 404。切换站点访问模式前，须先在私有模式验证同一个插件通过新增的所有者检查。只有公开开关和所有者配置同时存在时，Worker 才挂载 `/api/analysis`。CORS 仅为允许的 Pages 来源返回响应头。

发布前保留 Sites 已保存第 13 版及原 D1 绑定、插件 1.0.4 和最近成功生产 Pages 发布的 `github-pages` 归档。第 13 版来源为 `4c4bc9afd516db903615f037049ec12849093c70`。当前 Pages 回滚点为 `33ad0f66efa6c9fabf69793ec83e25abfd1b86f3`，已归档发布 `45478713537`。 [Pages 原发布](https://github.com/yorkchenai/stock-data-center/actions/runs/45478713537)

1. 从通过验收的分支提交运行 `GITHUB_SHA=$(git rev-parse HEAD) python -m stock_analysis.pages --output <配对目录>/pages --snapshot-service https://stock-data-center-voice-probe.finalnoodle2.chatgpt.site --snapshot-runtime-output <配对目录>/runtime`。将 runtime 复制到上述第 13 版 SHA 的 Site 源码副本的 `worker/snapshot-runtime/`，在该副本运行 `git apply --unidiff-zero <仓库>/scripts/site-snapshot-release.patch`。用 esbuild 把 `worker/snapshot-release.mjs` 打包为 `dist/server/index.js`，归档时保留现有 `.openai/hosting.json`、`drizzle/` 和构建输出。同一次构建的 Worker 和 Pages 共享模型版本和输入。
2. 批准后，在原 Site 的环境设置填入 `SNAPSHOT_MCP_OWNER_EMAIL`（现有插件所有者的已验证邮箱）和 `SNAPSHOT_PUBLIC_ORIGIN=https://yorkchenai.github.io`。保持公开开关关闭，按原 Site 的源码发布流程部署配对 Worker，验证现有插件 1.0.4 的原连接、工具发现与已认证调用。保留原项目 ID 和逻辑 D1 绑定 `DB`，沿用原迁移文件。
3. 验证 MCP 后切换 Site 的站点访问模式为 `public`。先确认匿名 `/mcp` 和诊断路径被拒绝，其他已登录账号也无法调用所有者工具，且外部请求不能伪造 Sites 注入的身份头。随后设置 `SNAPSHOT_PUBLIC_ENABLED=1` 并发布同一配对的 Pages 文件。确认常规 Pages 自动发布在后续使用配对产物或同步更新两端，避免日历滚动导致版本漂移。用真实 Pages 来源、无 Cookie 查询 300078 和 110022，用现有 Live 工具核对 `snapshot_id` 和 `model_version`，再复查 D1 命中零回源。Sites 平台可在重发时刷新工具发现，仍使用既有插件连接。
4. 需要回滚时，先关闭公开开关并恢复 Site 所有者访问策略，再重新发布已保存的第 13 版，保留原 D1 绑定和插件连接。恢复备份的原 Pages 归档。回滚无需还原或删除 D1 表或快照。行情使用和再分发风险继续保留上述记录。

GitHub runner 的实盘路径也会从本次隔离 D1 读取实际输入交给独立 Python 复算。临时输入仅在测试进程目录保留，CI 归档仅含请求状态、时间、计数、排名、缺失和校验结果。实盘失败直接报告，fixture 结果单独生成，runner 结果须与托管测试 Site 的证据分开记录。
