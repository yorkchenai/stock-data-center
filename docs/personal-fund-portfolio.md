# 我的基金持仓 V1

## 架构与访问边界

GitHub Pages 的场外基金页通过可选入口打开独立的 HTTPS 站点。个人页面、登录和 `/api/*` 在同一个 Cloudflare Worker 来源下运行；私有 D1 通过 `PORTFOLIO_DB` 绑定。现有共享快照 Worker、D1、股票、基金详情和 Live 不承担个人交易读写。“我的基金持仓”入口由 `PORTFOLIO_URL` 配置启用。Pages 产物只保存入口 URL，私有页面及 D1 记录不参与 Pages 构建。

管理员账号使用 Worker Secret `PORTFOLIO_ADMIN_USER`，密码使用带独立随机盐的 PBKDF2-HMAC-SHA256（600,000 次）校验值 `PORTFOLIO_ADMIN_HASH`。8 小时的随机会话使用 HttpOnly、Secure、SameSite=Strict 的 `__Host-` Cookie，D1 仅存令牌哈希。退出、到期或更换账号和密码校验值都会使旧会话失效。写操作校验同源 Origin。15 分钟窗口最多 8 次登录尝试，全局计数覆盖账号拼写和客户端地址，达到上限后显示可重试时间。没有注册端点。交易响应禁止缓存，配置关闭 Worker 观测日志，应用不记录请求体。备份仅由已登录管理员下载，建议按个人财务文件保存。

## 数据表

| 表 | 数据 |
| --- | --- |
| `portfolio_transactions` | 基金代码、类型、状态、申请与平台确认字段保存在规范化 JSON 中；版本、创建时间、更新时间及软删除时间由 Worker 管理 |
| `portfolio_funds` | 各基金流水完整性声明，默认待核实 |
| `portfolio_audit` | 交易创建、编辑和删除的版本与前后快照，写入与交易更新在同一 D1 事务完成 |
| `portfolio_sessions` | 会话令牌哈希、凭据版本、过期时间 |
| `portfolio_login_limit` | 管理员登录窗口及次数 |
| `portfolio_restore_guard` | 空账本恢复期间的事务保护；正常状态为空 |

本地可复核的操作包括交易新增、修改、软删除、补录、历史版本冲突和备份恢复。JSON 备份包含有效与已删除的交易、完整性设置及审计记录，不包含账号校验值和会话。恢复只适用于空账本，整批验证并原子写入。V1 上限为 2,000 条交易、20,000 行可恢复审计记录和 4 MB 的恢复请求。保留定期、可离线读取的备份。

## 核算口径

- 金额按整数分计算，份额和单位净值按百万分位计算。应用 BigInt 定点数，平台确认值保留原精度。日期使用北京时间，已确认交易按确认日、申请时间、创建时间和编号排序。待确认、已取消和未到确认日的记录不入账。
- 申购以平台的实际支付总额增加成本和外部投入，已支付手续费包含在这笔总额中。不用申请金额、历史净值或份额乘显示净值补足缺失的实际支付金额。
- 赎回的净额先用实际到账金额，其次用明确标为扣费后净额的确认金额；明确为扣费前、且手续费已知时，只扣一次。确认净额和实际到账单独累计。确认份额以平台确认数据为准，申请份额单独保留。金额有尾差时保留原值。
- 移动加权平均成本法下，赎回结转成本为赎回前持仓成本 × 确认赎回份额 ÷ 赎回前份额。每次按分四舍五入，清仓结清剩余成本。赎回已实现盈亏为净额减结转成本。净现金分红计入已实现收益。红利再投资的确认金额计入已实现红利与新份额成本，不计为外部投入。现金分红与红利转投只录实际发生的一种。
- 确认持仓市值等于当前份额 × 最新可用于这笔持仓的确认单位净值。浮动盈亏等于市值减持仓成本。累计总收益等于浮动盈亏加已实现盈亏。组合对各基金求和。基金贡献金额用该基金累计总收益，贡献占比用该金额除以组合累计总收益，合计为零或缺失时留空。
- 简单收益率等于累计总收益 ÷ 累计实际外部投入。资金加权收益率采用修正 Dietz 区间收益率，分子为期末资产净值减外部净流入，分母为各笔有符号的外部现金流按剩余在场天数加权之和。从完整记录的首笔外部现金流开始，未投入前期初值为零。实际到账日期缺失时以确认日近似并明确提示，已知尚未到账的确认净额计入期末应收。分母非正或区间不足时留空。
- 每只基金需要手动核实流水从首次持有起已完整录入。确认份额缺失、历史出现负持有、分红早于首笔申购、存在无法过账的转换、份额折算或确认行情过早时，对受影响的字段留空。组合收益及占比需要依赖项全部已知。转换保留双方代码、平台原始确认值和状态。自动成本结转和份额折算留待后续。
- 净值复用现有的天天基金／东方财富数据读取和校验代码。直接读取失败时使用现有 Worker 的公共基金快照，只读取公开净值。盘中参考采用现有天天基金估值，要求北京时间日期、净值基准和报送涨跌幅匹配。账本不从关联指数相关系数拟造估值。无可用估值则留空，官方当日净值公布后停止显示同日估算。组合估算需要全部在持基金都有有效估值。
- 组合单次读取至多查询 10 个基金的行情，超过范围的基金可在详情单查，缺少足够数据时组合市值留空。历史图使用未复权确认净值及确认日移动成本，空仓期间成本线断开。

## 独立验证

本地用 Workerd/Miniflare 及两套隔离 D1 验证登录、编辑删除、行情不足、备份和原子恢复。Playwright 使用 1440px 和 390px 的 Chromium 视口验证登录、持仓、图表、动态申请和确认字段及登出清理。仓库测试仅使用合成流水。手工核对的交易数据不随代码、测试夹具或迁移提交。

```bash
npm ci
npm install --prefix /tmp/analysis-snapshot-tools miniflare@4.20260730.0 esbuild@0.28.1
npm test
CHROMIUM_PATH=/usr/bin/chromium node scripts/test_portfolio_stage.mjs
```

`SNAPSHOT_TEST_TOOLS` 可指向其他隔离测试依赖目录。测试脚本使用随机一次性管理员账号与密码，退出即销毁测试数据库。真实管理员凭据和个人备份不要放入测试文件。

## 手动配置和上线

1. 在 Cloudflare 创建独立 D1（例如 `sdc-fund-portfolio-stage`），复制 `worker/portfolio/wrangler.example.toml` 为同目录下已被 Git 忽略的 `wrangler.local.toml`，填入独立 Worker 名称及实际数据库 ID。测试和生产必须使用不同的 Worker、D1 和账号配置。
2. 在仓库根目录运行 `npx wrangler d1 migrations apply sdc-fund-portfolio-stage --remote --config worker/portfolio/wrangler.local.toml`，并用 `npx wrangler deploy --config worker/portfolio/wrangler.local.toml` 部署隔离站点。直接访问该 Worker 的 HTTPS 地址验收。
3. 通过 Wrangler 或 Cloudflare Secrets 界面设置 `PORTFOLIO_ADMIN_USER`。本地生成并直接上传密码校验值，可在 Bash 使用以下命令。终端不开密码回显，校验值也不进入仓库。

   ```bash
   read -r -s -p "Portfolio admin password: " PORTFOLIO_PASSWORD
   printf '\n'
   set -o pipefail
   printf '%s' "$PORTFOLIO_PASSWORD" | node scripts/portfolio_password.mjs | \
     npx wrangler secret put PORTFOLIO_ADMIN_HASH --config worker/portfolio/wrangler.local.toml
   unset PORTFOLIO_PASSWORD
   ```

4. 先在隔离环境验收实际 Cloudflare 套餐登录时的 CPU 配额、Safari 实机、匿名拒绝、报价传输和导出恢复。上线时复制配置指向独立生产账本并设置新的生产凭据。只有独立生产 Worker 本身验收通过后，才在 GitHub Actions 仓库变量设置 `PORTFOLIO_URL`，用现有 Pages 工作流发布基金入口。需要摘除入口时清空该变量并重新发布 Pages，交易保留在独立 D1 中。
