# 查名普通HTTP接入文档与Python完整代码

状态：本地验证通过，尚未切换线上。用户要求补充线上文档，并明确不要SDK初始化，使用普通HTTP调用。范围仅文档/示例，R1；正式静态替换须确认本次发布范围，不能沿用旧7文件授权。

基线：分支`codex/lookup-python-docs-20261016`，起点`1e8bf40e82277ebed09fdbedfa9b9c209b5289c5`，开始干净；主仓既有工作保留。生产只读核对ACTIVE SHA256=`31e6b3e45b0864e5821b9bbe4edc4bea5c16a9cb1e05f8b5f984d848d0347daf`，运行deployed.16/b5479d9c加上一轮文档，重启镜像bc6e3c1f；未改变实际运行服务。共同流程日期/哈希见BASELINE.json。延续主文档7.15.13，不变更任何API契约或权限。

## 改了什么

- 从SDK零散片段改为普通HTTP：请求地址/头/体、响应、签名和重试逐步说明。
- `examples/name-lookup/lookup.py` 用requests直接调用三个API；SQLite先存幂等键、再发请求，保存lookupId；同一业务重跑只续查原任务。没有SDK初始化。
- 默认Python代码标签；每个接口页提供独立完整单次HTTP代码，不再引用undefined client/saved*变量。
- Python下载、Windows/Mac运行、交互输入、结果解释、完整源码、超时排队与错误成为可点击章节；保留Node原生fetch例子。下载包根目录是代码、说明和OpenAPI，没有SDK安装步骤。
- 只更新MANIFEST列明9静态文件（其中3个新增下载文件），三个公开接口和其余30接口不变。原不可变release目录未修改。

## 实际验证

- Python3.9.6/requests2.32.5：10项通过，含真实回环HTTP签名、子进程重启续查、SQLite并行同键、空姓名/异常区别；120秒情形使用虚拟时钟。Mac系统Python发出urllib3/LibreSSL提示，本轮HTTP测试通过，不声称HTTPS测试通过。
- Node25.9.0：已有13项通过，包含实际本地HTTP子进程。
- 页面内3段Python单次请求实际在mock requests下运行并验签；3段Node单次代码语法通过。
- 33接口页逐项等待对应h1、11查名导航、Python/HTTP标签、复制按钮、390px移动菜单与无横向溢出通过；控制台0错误。一次浏览器工具导航超时，随后DOM确认到达并完成全部逐页验证。
- 9个静态资源HTTP200且字节一致、源码/下载/ZIP/hash一致；生成确定性通过。
- 未做真实号码查询，未改或连接Windows/ADB/SYSTEM；无全量业务回归必要，未宣称生产验收完成。详见VALIDATION.json。

自审：业务ID绑定客户/地址/号码；请求键发送前持久化；每次请求重新nonce/签名；结果failed/网络超时不写空姓名；SQLite仅是同目录示例，跨主机必须共享业务库。示例所有真实调用需由使用者运行，浏览器仅加载静态文档。

## 发布与回退

以当前bc6e3c1f下次启动镜像为底，仅COPY这9文件，保留原7文件已发布内容。切换前检查ACTIVE/Compose/运行文件hash，备份6个已存在文件并记录3个原先不存在文件；准备独立候选镜像和pending Compose。实际宿主机执行D-075 `verify --live`，不修复媒体。

确认本次静态发布后，按下载文件/JSON/CSS/JS/HTML顺序原子替换，HTML最后；只登记下一次启动镜像，不重启云端、Agent、控屏或ADB。发布后核对9文件/public下载、页面导航、health/ready、D-075、容器ID/PID/启动时间，保存部署回执。

回退：校验当前文件仍是本候选后，恢复6个旧静态文件；3个新增下载可以保留为未引用版本化资源或在明确确认归属后移除。还原原文档overlay和原重启镜像/Compose引用，保持业务版本和既有回执不变；不恢复数据库，不重启任何服务。若发现并行部署则停止，禁止覆盖新的版本。

本地预览：http://127.0.0.1:8798/api-docs.html?scope=lookup#lookup-flow 。代码、网页与下载包可审阅，当前不能说线上已更新。
