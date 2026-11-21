# 科创50（000688）历史日线成交量单位核对

核对日期：2026-11-21

## 当前接口与字段

东方财富历史 K 线接口 `push2his.eastmoney.com/api/qt/stock/kline/get`，`fields2=f51,...,f61`。

- `f56`：成交量，**手**；一手通常为100股。
- `f57`：成交额，**人民币元**。
- CSV `volume_lots` 原样存储 `f56`，未进行乘100或除100的转换。
- CSV `turnover_cny` 原样存储 `f57`，未进行万元换算。
- 如需股数，新增衍生列 `volume_shares = volume_lots * 100`，不要覆盖原始数据。

## 参考资料（第三方接口文档，不是交易所官方原始单位证明）

- https://github.com/wlor0623/llm-dev-knowledge/blob/main/knowledge-base/eastmoney-quotes-api/endpoints/kline-history.md
- https://github.com/wonchermaine960/eastmoney-cli/blob/main/docs/API.md
- https://ashareapi.com/docs/migrate-from-eastmoney/

## 验证范围与限制

上述独立文档一致支持字段映射和单位约定；结合现有解析代码可确认**没有做单位转换**。尚未通过上交所官方逐日成交量数据进行数值交叉核验，因此属于**接口字段单位核实**，不等于独立数值准确性审计。

注意：000688 是指数点位，不是单只股票成交价。不能用 `成交额/(成交量*100)` 与指数点位高低价比较来验证单位；该公式仅适用于价格与量额对应同一交易标的的情形。
