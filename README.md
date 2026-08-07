# Phone Cloud

Phone Cloud 是“云端平台 + Windows 管理器 + Android 真机”的设备业务平台。当前主能力是：

- Windows 管理器通过 ADB 上报和管理手机。
- 按需同步设备短信库，并提供分页查询与验证码接口。
- 使用 Airtest/Poco 执行小红书图库扫码任务。
- 管理员确认设备信息后上架，普通用户只看到已上架设备。
- 扫码失败时保存截图、页面元素树和步骤日志。
- 通过 scrcpy H.264 流在设备详情页实时查看并控制手机。

## 目录结构

```text
phone-cloud-platform/
├── public/                    # 用户端和管理员前端
├── server/                    # HTTP API、鉴权、任务和数据持久化
│   ├── index.mjs
│   └── state-repositories.mjs
├── windows-agent/             # Windows 设备执行器
│   ├── src/
│   │   ├── index.mjs          # 扫描、任务、短信、证据、Airtest worker
│   │   └── config.mjs         # 配置读取、默认值和风险检查
│   ├── scripts/
│   │   └── xhs_airtest_poco.py
│   └── config.example.json
├── deploy/                    # Docker、Nginx、备份和冒烟脚本
├── docs/                      # API、上线和部署文档
└── scripts/                   # 本地启动与平台冒烟测试
```

## 运行架构

1. Windows 管理器定期执行轻量 ADB 扫描并向服务端上报设备状态。
2. 新设备先进入待确认状态，管理员配置名称、SIM 和账号槽位后上架。
3. 服务端负责用户权限、设备锁、任务队列、状态机和数据存储。
4. Windows 管理器只领取属于自身的任务；同一手机同一时刻只执行一个任务。
5. 小红书扫码由常驻 Airtest/Poco worker 执行，二维码通过 ADB 推送到手机相册。
6. 短信默认不做全设备后台轮询；用户打开短信库或主动刷新时才创建同步任务。
7. 实时控制由 Windows 管理器建立 scrcpy 会话，云端只转发加密 WebSocket 数据，不解码或保存手机画面。

接口中的扫码任务类型暂时仍使用 `xhs_qr_appium`，这是兼容字段；实际执行模式为 `windows_airtest_poco`。不要据此安装 Appium。

## 本地服务端

```bash
cp .env.example .env
npm install
npm run check
npm run start:local
```

默认地址为 `http://127.0.0.1:8787`。生产环境必须使用独立密钥、Postgres、可信来源限制和反向代理；不要沿用示例 token。

## Windows 管理器

1. 安装 Node.js 18+、Python、ADB platform-tools。
2. 复制 `windows-agent/config.example.json` 为 `windows-agent/config.json`。
3. 在后台创建 Windows 管理器，将一次性 token 写入 `agentToken`。
4. 安装固定版本的 Airtest/Poco，或保持 `autoInstallAirtest=true`。
5. 启动：

```powershell
cd D:\phone-cloud-platform\windows-agent
npm start
```

Windows 管理器会为在线手机准备并维持 Airtest/Poco worker，并在用户发起实时控制时启动 scrcpy。Appium 和 UiAutomator2 已退出主链路，不再需要安装。

## 验证

```bash
npm run check
npm run test:smoke
```

上线后还应检查：

- `GET /healthz`
- `GET /readyz`
- 管理员登录、设备列表、Agent 心跳
- 一台真机短信刷新
- 一台真机小红书扫码成功与失败证据

## 数据原则

- Postgres/JSON snapshot 保存事实数据，Redis 只保存在线 TTL、锁、限流和实时进度。
- 任务列表只返回轻量数据，截图和元素树通过鉴权接口按需加载。
- 不直接删除生产数据；迁移前先备份并执行部署冒烟测试。
