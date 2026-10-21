# lookup-admin-20261021-rc.3

最终组合候选，未上线。业务范围沿用rc.1，包含rc.2的账号资格过期展示修正。

rc.1/rc.2组装器错误地将直接哈希字典按嵌套files结构读取，父层完成后退出，导致rc.2临时目录只包含rc.1；上传前PRODUCTION_DIFF哈希门禁拦住。本候选组装器在已验证post-human组装后逐层校验、应用两个不可变增量，并强制核对完整最终生产差异，任一失败不产生成功回执。未改旧标签，未把失败包部署。

纠正rc.2历史记录：其“1029项”数字记录错误，旧临时目录实际1028项；rc.2展示修正另有14项定向通过。最终验证仅以本目录RESULTS为准，原日志保留以便审计。

发布、灰度、回退流程沿用rc.1，必须先取得具体维护窗口授权。无新增业务/依赖/DDL/配置变化；不动ADB、SYSTEM和媒体。production diff与hash验证同时用于构建及切换前核对。

浏览器实际验证又发现图片blob URL被原CSP拒绝；rc.3将管理员鉴权取得的图片转为data URL显示，沿用已有img-src data:，不扩大安全头。已保留损坏/过期提示。

## 已完成的上线准备（2026-10-21）

运行代码源提交e61427dec209bb37b9a06862678a9b3095bdf900 / lookup-admin-20261021-rc.3；新增镜像sha256:7a5bc48a5ee3fa9dba1d72acc4b090890f16fb13a8b7bb9c5e1eb54ec5eabacf。云端暂存/回滚在 `/opt/phone-cloud-staging/lookup-admin-20261021-rc.3`；Windows在 `D:\PhoneCloud\staging\lookup-admin-20261021-rc.3`。不等于线上已加载。

云端组合运行文件before/after哈希已检查；数据库约645MiB自定义格式备份通过pg_restore --list结构检查（不是完整恢复演练）；旧镜像压缩归档约63MiB；ACTIVE副本与全部备份SHA见PREPARATION_RECEIPT。隔离镜像以production模式使用独立临时PG、无外部网络、无生产卷/密钥，health/ready/三个静态资源/后台列表200、未登录401、全部候选文件hash通过，两个临时容器已删除。首次JSON烟测被生产PG要求拒绝，未影响线上；已修正准备脚本调用独立PG验证。再次准备需上传complete-preparation.py及两份既有managed-lookup初始化SQL到新暂存目录，已有回滚目录禁止覆盖。

Windows7份查名运行文件已暂存，既有5份已备份，新文件2份未写运行目录；运行及备份hash匹配，4个Node模块语法和3个Python 3.9 AST通过。Agent24968与ADB8988仍SYSTEM，未调用ADB客户端、未重载Agent。回执见WINDOWS_PREPARATION。真实Windows OCR/手机验收未做。

上线前重新核实生产无漂移、剩余空间/当前任务与控屏，取得本次云端+Agent维护授权；备份有时效，切换前再做新快照。权限名单沿用page-helper/HELPER_GRANTS.json中的精确账号，后台读取权限不扩大到普通用户。运行标签、镜像标签和准备回执分别保存，不移动旧标签。
