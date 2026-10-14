# platform-core-20261014-rc.1

本地核心集成候选，**尚不具备正式切换条件，未上线、未推送**。本轮完成源码整合、自动测试和发布材料准备，不包含尚未确认范围的小红书数据采集。

## 已纳入

- `lookup-async-20261014-rc.12` 的完整不可变覆盖链：49台名单、最多5台内部并发、提交/获取结果双接口、同客户同号码在途防重、结果逐条返回、SDK/文档/管理页，以及历次姓名识别、加载等待、切号和冷却兼容。
- `device-recovery-20261014-rc.1` 的4文件补丁：扫描全路径防重、恢复动作前重新校验、轻量安装器探测及失败分类。保留现行D-024持续恢复规则，不宣称解决USB物理掉线。
- 从当前生产容器按SHA256补齐`package-lock.json`、登录背景图；从已验证查名候选整理Docker构建所需的3份接入文档。补充构建排除规则和组合包校验脚本。没有整仓导入共享工作区。

## 本轮验证

根语法、Node全量654/654、Agent291/291、恢复专项22/22、查名Python136/136、执行器163/163、SDK Node6/6/Python9/9通过。全量与Agent有重叠，不相加宣称独立覆盖数。

隔离PostgreSQL归档/别名事务、设备隔离、迟到结果竞态和HTTP通过；真实等待121000ms后8个新键仍只有1个查询任务。合作方下载包+独立HMAC+Python持久样例验证：5路同时运行、6个合成号码恰好6个query、一台保持121002ms时其他5个可完成；重启、重复回执、429与关闭池503通过。这里的“设备”是fake Agent，真实手机查询0。

新建目录执行`npm ci --omit=dev --ignore-scripts`成功，使用新安装的生产依赖完成本地HTTP烟测。**本机没有Docker，未构建或启动Node22容器镜像**；本地Node版本见VERSION。原测试脚本proof中的rc.8表示继承的夹具标签，实际执行源码为本候选组装结果。

## 复现与交付

```sh
python3 releases/platform-core-20261014-rc.1/verification/prepare-local.py --out /tmp/platform-core-review
python3 /tmp/platform-core-review/verification/verify-candidate.py
```

组装不会启动服务或安装依赖。完整运行目录以新MANIFEST标识，旧候选链和标签不移动。云端构建只能使用本次完整输出和明确的Dockerfile；不使用根仓旧业务或未绑定镜像的`Dockerfile.cached-base`。无需重建冻结的投屏bundle。

生产比较、升级顺序、未验项与回滚约束见[上线准备清单](RELEASE_NOTES.md)。正式部署回执尚未生成；不得把本地候选当作已部署版本。
