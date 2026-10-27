# Nginx 隔离测试保护（2026-10-27）

目标：修复测试入口的权限副作用，不改变在线服务、心跳阈值或设备恢复逻辑。

## 已确认故障链

另一开发窗口的库存压缩测试以 root 启动独立 Nginx，但最初仅指定 `-p`，未覆盖 Ubuntu Nginx 编译时的五类绝对临时路径。无 `user www-data` 的测试配置沿用默认用户；Nginx 在校验/启动阶段会按该用户修正临时目录属主，正式 www-data worker 因此失去访问权限。`nginx -t/-T` 不是无副作用的文件读取。

2026-10-27 北京时间 15:46:44–15:48:49，该站点错误日志共记录 31 条权限错误；其中 15:46:49–15:48:49 的 heartbeat、devices/sync 各 5 次返回 500，与 Windows HTML/JSON 解析失败精确对应。超过原 90 秒新鲜度阈值后，平台整批显示离线。这不证明手机 USB 同时断开，也不同于此前 158 号的 USB 断连。

执行来源已由“云手机小红书数据同步”窗口的命令、失误说明、修正后的脚本及现场日志交叉确认，不再仅为推测。另一窗口已恢复目录为 www-data:root 0700，并在测试脚本显式配置 body/proxy/fastcgi/uwsgi/scgi 独立目录。本轮不覆盖该窗口仍在使用、最终需回退的生产压缩配置。

机制依据：[Nginx 1.18 ngx_create_paths](https://github.com/nginx/nginx/blob/release-1.18.0/src/core/ngx_file.c#L561)、[配置初始化调用](https://github.com/nginx/nginx/blob/release-1.18.0/src/core/ngx_cycle.c#L329)。生产没有权限变更审计，未取得当时 chown 系统调用记录；目录的当前 ctime 会随临时文件创建变化，不能将其当 chmod 证据。

## 使用保护入口

本地无外联单测：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/nginx-isolation -p 'test_*.py' -v
```

仅在已获准的 Linux 诊断环境执行真实隔离测试；脚本可经 SSH stdin 传入，不需安装到生产应用。必须先通过普通系统入口切为非特权身份，例如：

```sh
runuser -u nobody -- python3 - < deploy/nginx-isolation/verify.py
```

不要使用 root 直接执行，也不要修改目录权限来迎合测试。当前宿主 `/tmp` 为 root:root 0700；入口使用已有 `/var/tmp` 下随机 0700 子目录，不修改 `/tmp`。

入口的技术保护：

- root、有效 capabilities、setuid/setgid 或带 capability 的 Nginx 二进制均拒绝；root 在创建目录/运行命令前被拒绝。即使是非 root，只要对生产临时目录有写权限（例如 www-data），同样拒绝。
- 不接收任意生产配置或配置片段。显式隔离五类临时目录、pid、lock、日志；无 include、无生产端口、无真实凭据或数据。
- 上游与 Nginx 都只监听本次私有 Unix socket，不建立 TCP 监听或请求生产 API。
- 66,700 字节合成 POST 强制触发临时文件落盘，校验上游收到原字节；gzip、identity、gzip;q=0 和非目标路由四例验证响应原字节一致。
- 开始、配置检查后及退出时比较五类生产目录的 uid/gid/mode/inode；出现漂移即失败，不自动 chown/chmod/reload。
- 有界等待；只终止本次创建的测试 PID，关闭自有 socket 并清理随机测试目录。不调用 systemctl、ADB、Agent、Hub 或手机。

## 本轮验证及边界

- 本地专项 13/13 通过。
- Linux Nginx 1.18.0：root 和 www-data 两种负例正确拒绝；最初非特权测试因 `/tmp` 0700 在 mkdtemp 阶段失败，未启动 Nginx。改用 `/var/tmp` 后 4/4 真实代理用例通过，uid=65534，确认请求落盘、无生产目录写权限，生产目录元数据不变，测试资源清理完成。
- 该工具是测试入口，不是生产服务补丁，不需重载 Nginx 或重启任何设备。未执行应用全量测试/真机业务任务，因为未修改这些链路。
- 不能阻止管理员绕过入口直接执行任意 root 命令，也不能保证网络、USB、磁盘等其他故障永不发生。跨窗口采用与长期效果需分别确认；不能把文档要求说成全机强制访问控制。

版本在独立 `codex/nginx-isolation-20261027` 分支保存；修复不覆盖共享仓原有 240 项工作。若取消本工具，只停止使用它；没有生产配置或进程需要回滚。发生同类线上错误时先取证，禁止通过重启 ADB/Hub 掩盖入口故障。
