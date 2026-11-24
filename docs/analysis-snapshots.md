# Analysis Snapshot 隔离验收

同一个 `snapshot_id` 绑定标的、原始输入、模型版本、计算时间与结果。股票快照调用现有 `web/providers.mjs` 和 `web/engine.mjs`。基金复用已有净值解析、`performance.mjs`、`sector-model.mjs` 和 `sector-browser.mjs`。常用区间的风险和收益点序列在写入前计算。基金累计净值与总回报保持独立，覆盖不足或缺少无风险利率时保留缺失原因。指数与基金日期各自记录。

## 读取与更新

- MCP 第一问仍用 `get_stock_analysis` 或 `get_fund_analysis`。成功返回摘要、`snapshot_id`、数据日期及模型版本。Worker 内等待超过 7 秒时返回 `building` 并用 `waitUntil` 继续运行。客户端实际等待还受网关耗时影响。若返回 `after_snapshot_id`，以同一组查询参数带回该字段并省略 `refresh`，直至新快照就绪。续查不会启动另一轮取数，刷新失败会明确返回。结果缺失时不会发布假快照。
- `get_analysis_details` 接收 `asset_type`、`symbol`、`snapshot_id` 和 `category`。历史与指标支持指定日期、最近 1–120 条、区间分页及指定字段最大最小值。风险支持常用区间，关联分析可按指数代码读取模型和对应日期。
- D1 每次从主库启动独立会话。快照头及压缩分片在一个事务中插入，提交后才返回 ID。每个分片上限 450,000 字节，每个快照至多 12 个分片，原始序列整体上限 20 MB，单次 JSON 响应上限 4 MB。持续时间最长 45 秒的数据库锁防止多个 Worker 重复构建同一代码、日期和模型版本。
- 股票默认从 2025-01-01 计算，保留指定历史计算起点。当前窗口完整快照最多保留 4 小时有效期，并且不会跨过下一次预期收盘行情发布；历史窗口 24 小时。基金完整快照有效 30 分钟，部分结果 10 分钟。冷启动停留在 `building` 时可按同一代码查询，不传 `refresh`。显式刷新生成新 ID，旧 ID 到原定更新时间前仍可读取。过期内容不可作为当前数据提供，物理清理保留时间为过期后 7 天，并在之后的成功写入时批量执行。
- 计算版本哈希包含分析源码、日历、基金事件及基准和指数配置。升级后默认查询仅使用当前版本，旧 ID 在有效期内仍返回原版本。页面按快照读取常用区间成果，并在模型版本一致时用同一套函数计算用户自选区间。

## 隔离运行

以下命令生成本地 Pages 预览，只启动回环 HTTP 和隔离的 workerd，不修改生产服务。运行环境需 Python 项目依赖、Node 24 及 Chromium。

```sh
npm ci --ignore-scripts
npm install --prefix /tmp/analysis-snapshot-tools --no-save esbuild@0.28.1 miniflare@4.20260730.0
python -m stock_analysis.pages --output work/snapshot-stage-pages --snapshot-service http://127.0.0.1:8787
node scripts/test_snapshot_stage.mjs --fixture
node scripts/test_snapshot_stage.mjs
```

普通构建省略 `--snapshot-service`，继续使用浏览器独立模式。隔离浏览器可打开 `index.html?symbol=300078&snapshot_id=…` 或 `funds.html?fund=110022&snapshot_id=…`。显式指定 ID 查不到时页面报错，避免无标记替换。普通查询失败或主动股票／混合基金的共享快照少于已验证的 14 条指数时，页面回退整套浏览器独立分析，并展示独立来源、日期与版本。

## 权限和上线边界

快照存储使用现有 D1 类型与绑定，不需要 KV。KV 在跨地区通常为最终一致，新 ID 的立即读取受其全局传播限制。生产 D1 迁移须在获得发布授权后对原有绑定执行。Cloudflare D1 免费方案的公开限额包括每库 500 MB、账户 5 GB 以及每账户每日 10 万行写入和 500 万行读取。实际容量取决于压缩率、标的数和刷新频率，平台另外按请求和数据库操作设限。[D1 限额](https://developers.cloudflare.com/d1/platform/limits/) · [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/) · [KV 一致性](https://developers.cloudflare.com/kv/concepts/how-kv-works/) · [D1 Sessions API](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession)

网页接口默认关闭。隔离测试仅显式允许指定来源和五只标的，网页端不携带插件凭证。CORS 限制浏览器读取，不能验证调用者身份。公开发布前须确认每个行情源的再分发权限，决定使用受验证账户访问还是启用有限标的公开服务，并核实实际托管的站点网关、独立配额和跨地区按 ID 读取。现有私有站点的网关权限保持启用。正式插件上线还需在同一份已验收 Worker 上验证认证、既有兼容工具、工具发现及 iPhone Live 连续追问。

CI 归档仅含请求状态、时间、计数和校验结果。实盘路径失败直接报告；fixture 结果单独生成。
