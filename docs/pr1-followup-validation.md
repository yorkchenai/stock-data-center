# PR #1 补充验收

核实及运行日期为 2026-11-21（上海时区）。修改继续保存在 feat/multi-instrument-analysis，面向现有 PR #1 审查。

## 688981 停牌证据

中芯国际因筹划发行A股购买中芯北方少数股权及关联交易，自2025-09-01开市起停牌。公告2025-021在2025-08-30披露了起始日期。[公司停牌公告（巨潮资讯）](https://static.cninfo.com.cn/finalpage/2025-08-30/1224624974.PDF)

上交所披露的公告2025-024确认停牌终止日为2025-09-08，2025-09-09开市复牌。与XSHG日历相交后，停牌交易日为09-01、09-02、09-03、09-04、09-05、09-08，恰好解释第一阶段全部6日缺口。[公司复牌公告（上交所）](https://star.sse.com.cn/disclosure/listedinfo/announcement/c/new/2025-09-09/688981_20250909_2BQ9.pdf)

证据登记在 stock_analysis/suspensions.json，限定市场、代码、类型和闭合日期范围，并保留公告号、披露日、URL和核实日。日历校验新增已确认停牌、未核实缺口、停牌日行情冲突和应有活跃交易日数。原始缺口列表保留，计算输入保持真实成交记录。该证据登记目前覆盖此单次停牌，股票整体完整性继续标为未全面验证。

## 保存方案

- 每次运行自动生成独立ZIP，包含行情、逐日指标CSV/JSON、五图、离线HTML预览、完整报告和简要运行记录。
- ZIP外附SHA-256文件，包内manifest.json逐文件记录大小和SHA-256。先写临时ZIP再发布，打包错误清除不完整包并留下失败记录。
- output-root/run-records保存每次独立JSON，包含代码、请求及实际来源、区间、状态、时间、原输出位置和Actions运行链接。并发运行各自保存，单文件替换原子完成。失败取数同样保存诊断包。
- 本地工作目录受执行环境生命周期限制；Actions Artifact请求保留30天；长期可选持久化磁盘或手动工作流persist上传Release附件，三种保存方式的访问与删除规则见README。
- PR离线CI自动生成真实科创50样本并上传可下载Artifact。股票工作流复用原generate-indicator-charts.yml，可按代码运行并显示下载链接。
- Release任务先上传Draft再发布，使用唯一运行标签和原代码提交。该长期上传路径尚未实际执行验收，当前GitHub CLI读取Actions API时返回Forbidden；其余已验证范围见下文。

## 自动化与文件保护

本地运行 python -m unittest discover -s tests -v，26项测试全部通过。新增7项覆盖6日停牌、额外未知缺口、其他代码隔离、部分区间、停牌行情冲突、ZIP/清单校验、离线预览、失败诊断、打包失败恢复和并发记录。

将基线856baa6的全部15个results跟踪文件与当前文件逐字节比较，结果完全相同，其中包含原科创50CSV、指标CSV和五张PNG。原指标数值回归测试同时通过。

新增产物逻辑保持逐日指标CSV/JSON数值格式，报告增加schema_version=1和run_id。前端可直接按唯一升序date读取相同记录并分组绘制五图，初始NaN继续序列化为null。

## 在线回归

请求区间2025-01-01至2026-11-20，以下流程均完成真实在线取数、计算、五图和ZIP生成。

| 代码 | 来源 | 行数 | 正常停牌缺口 | 未核实缺口 |
| --- | --- | --- | --- | --- |
| sh688981 | tencent | 450 | 6 | 0 |
| sh600519 | tencent | 456 | 0 | 0 |
| sz000001 | tencent | 456 | 0 | 0 |
| sz300750 | tencent | 456 | 0 | 0 |
| sz399006 | tencent | 456 | 0 | 0 |

此次东方财富请求返回503后，以上自动主备均采用腾讯成功。所有运行报告保留具体尝试及错误。

本次云端执行机器上，产物位于仓库根目录相对路径如下。工作目录产物应导出后保留。

- `work/followup-analysis/sh688981_stock/sh688981_stock_20261121T145323Z_9iqx9xpb.zip`
- `work/followup-analysis/sh600519_stock/sh600519_stock_20261121T145333Z__4ilfwjh.zip`
- `work/followup-analysis/sz000001_stock/sz000001_stock_20261121T145342Z_m08a9t3x.zip`
- `work/followup-analysis/sz300750_stock/sz300750_stock_20261121T145351Z_s7r84094.zip`
- `work/followup-analysis/sz399006_index/sz399006_index_20261121T145401Z_28clz36r.zip`

## 复核命令

```bash
python -m unittest discover -s tests -v
python -m stock_analysis 688981 --start 2025-01-01 --end 2026-11-20 --output-root work/analysis
python -m stock_analysis 600519 --start 2025-01-01 --end 2026-11-20 --output-root work/analysis
```

远端PR测试及Artifact上传状态以PR检查记录为准。后续继续扩展有证据的停牌与上市资料，已确认日期以外的缺口保持未核实。
