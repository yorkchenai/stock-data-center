# 场外基金浏览器查询

`python -m stock_analysis.pages --output work/fund-preview` 生成相对路径静态站点。可通过普通静态服务器预览，用户访问发布后的 Pages 不需要 Python。基金页面输入六位代码查询，名称搜索可添加至列表，自选仍保存在当前浏览器。

## 取数和计算

- 东方财富移动端的 `FundMNHisNetList` 和 `FundMNDetailInformation` 在真实 `yorkchenai.github.io` 来源返回 HTTP 200 和 `Access-Control-Allow-Origin: *`。三个样本的业务码均为 `61136`，没有净值、分页数据或基金概况。该接口未用于实际结果。
- 优先尝试用 HTTPS fetch 读取 `pingzhongdata/{code}.js` 和目录的文本。跨域读取失败时使用没有同源权限的 sandbox iframe。主页面验证消息的来源窗口、隔离来源和请求标识，再校验基金代码和净值数据。iframe 请求结束后移除。
- 分红、份额折算和总回报指数按 Python 口径复现。净值、累计净值和总回报各自保留。缺少确认成立日期或日频事件证据时相应字段保持缺失。
- 排名沿用 20/60/120 日、Pearson、偏相关、OLS、Ridge、Elastic Net、滚动稳定性和持仓证据。候选价格来自股票引擎和可读取的中证历史。指数板块图使用股票引擎的 OHLCV 和共同指标实现，量纲为手，交易日缺口中断指标预热。因行情供应商和覆盖差异，浏览器的候选集合可能小于 Python 的全量中证研究集合。
- 现有中证端点在发布项目来源不可读。未映射特殊指数可以随构建传入指定的 `--fund-index-snapshot` 文件。该可选文件只接收目录中的特殊指数，不会默认生成或发布。顶层使用 `{"schema_version":1,"indices":{...}}`，按指数代码保存 `code,name,basis,currency,source,retrieved_at,first,last,internal_gaps,rows`。其中 `basis` 为 `price`，`currency` 为 `CNY`，来源含可核验 HTTPS URL，行使用 `date,close` 和可选 `open,high,low`。页面显示实际截止日和静态来源。
- 本地 Python 及可选 JSON 导入继续可用。目录、析出的净值和行情不会写入浏览器持久缓存。

## 验收

GitHub Actions 首先访问现有生产项目确认真实来源，再在隔离测试浏览器内提供 PR 构建的静态资产。外部取数请求直接发往供应商，正常校验 CORS。此流程不会部署 PR 到 Pages。测试用临时逐日输入复算 Python，产物只上传截图和摘要。

[真实来源的接口探测](https://github.com/yorkchenai/stock-data-center/actions/runs/45348152256/artifacts/14899431159) · [三只基金的浏览器页面及 Python 对照](https://github.com/yorkchenai/stock-data-center/actions/runs/45350231205/artifacts/14900221222)
