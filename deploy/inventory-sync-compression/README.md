# 库存同步响应压缩候选

版本：`inventory-sync-20261027-rc.1`。仅临时验证，结束恢复代理配置及 rc.21 采集器；不永久发布。

## 当前受限测试入口（2026-10-27 已采用）

复用 `../nginx-isolation/verify.py`，从已审核 `nginx-isolation-20261027-rc.1` 原样导入；SHA256 `fbf5ccfbb61d6646aca69420a9f7bedf07c3600bd3b715e6207e9f972f22afcd`。实际 `/private/tmp/pc-invsync-isolated.py` 已替换为相同字节，彻底移除旧的 root SSH、TCP 上游和真实库存/生产配置输入。直接执行本机入口不会再自动连接云端。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/nginx-isolation -p 'test_*.py' -v
```

只有获准的 Linux 隔离验证环境才运行真实测试；通过该环境既有系统入口切到无权限身份后，将经哈希确认的同一脚本传入：

```sh
runuser -u nobody -- python3 - < deploy/nginx-isolation/verify.py
```

不传生产配置/片段或业务样本；不执行旧的自动 SSH 编排。历史 `windows-agent/data/inventory-sync-20261027/qa-tools` 仅用于事故取证，不是可复用运行入口；旧入口副本另存 `.py.txt` 保留证据。现有压缩生成器及 rc.4 采集逻辑均未修改，也没有发布或重测手机。

本轮采用回执见 `isolation-adoption-20261027.json`：13项单测、root/www-data负例、nobody四项真实代理用例通过，生产目录元数据及服务PID不变。该入口不提供生产配置修复、服务重载或设备恢复能力；不能阻止管理员绕过它另行执行任意命令。

## 证据与范围

2026-10-27 15:07 的 Windows 日志显示读取 `/devices/sync` 响应超时（25 秒）；同时间云端应用响应耗时约 50 毫秒。Nginx 在 15:07:14、15:07:44 分别只发送 650196、520596 字节，正常响应约 753000 字节。两端时钟误差不足 1 秒。失败发生在大响应传输阶段；公网瓶颈的具体来源仍未证实，不能归因于手机元素树或云端数据库查询。

实际代理仅启用默认 gzip 类型，JSON 未压缩。候选只为 `/api/v1/windows-agents/单段ID/devices/sync` 增加 gzip level 1，复制原上游代理指令。认证、返回字段、HTTP 状态、库存缓存 90 秒守卫、Agent 25 秒超时、任务调度均不修改。客户端不接受 gzip 时仍返回原文。其他 HTTP 与投屏路径保留原配置。

实际配置基线 SHA256：`8b0b5016fe08bdaac338e65cf8b6dfa61843e7496d9703728b21fd98d920c4b3`，目标 `/etc/nginx/sites-enabled/sms-code-center`。生成器遇到重复安装、不明确入口或上游不匹配即停止；生产应用和恢复另须逐字节哈希核对，保留权限及备份。

## 验证与临时应用

- 本地测试检查范围、保留原配置、拒绝覆盖与 gzip 字节一致性；媒体鉴权、会话和 relay 回归另执行。首次 relay 测试因本 worktree 缺少 `ws` 未运行，连接既有依赖后重测通过，不升级依赖。
- 隔离验证必须显式设置独立的 client_body、proxy、fastcgi、uwsgi、scgi 五类临时路径；仅设置 `-p` 不足以隔离 Debian Nginx 的绝对默认路径。本轮初次验证遗漏此项，15:46:44–15:48:49 产生31条目录权限错误；随后生产配置校验恢复 www-data 所有者，修正隔离路径后重测通过，恢复后无新增同类错误。这次执行失误与15:07/15:14的既有响应超时分开记录。
- 隔离 Nginx 1.18 实际代理测试：446150 字节库存样本压缩为 54365 字节，解压字节及 SHA256 完全一致；identity、gzip;q=0 和 `/webrtc/` 反例保持原文。
- 发布前后在媒体宿主机运行现有 `verify.mjs --live`，必须通过 D-075。宿主无 Node PATH，使用现有容器文件系统的 musl loader + Node 在宿主执行，保持宿主 `/proc` / systemctl 可见；不是容器内 repository-only 验证。
- 临时应用前校验实际文件哈希并备份；修改后 `nginx -t`，失败立即恢复文件；通过后仅 graceful reload Nginx。应用服务、媒体、Windows 和 ADB 不重启。
- 观察真实 Agent 周期同步；随后对原样 `xhs-completeness-20261027-rc.4` 做正式 API 单机→双机→5 台并发，核对独立双遍有序帖子清单、30 日边界、同日基线和设置/锁恢复。
- 最后以比较哈希方式恢复原版采集器及 Nginx 文件，再次检查 D-075、SYSTEM 进程、设置与锁。若并发仍失败，保留失败证据，不能宣布修复成功。

私有执行证据位于共享仓忽略目录 `windows-agent/data/inventory-sync-20261027/`，不提交账号、令牌或设备原始数据。
