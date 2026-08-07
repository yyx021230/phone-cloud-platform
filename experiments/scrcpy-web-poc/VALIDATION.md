# 实机验证记录

验证时间：2026-07-13

验证设备：

- ADB serial: `10HFAAF4A8000NR`
- 厂商/型号：vivo V2442A
- Android：14 / SDK 34

## 结果

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| ADB 设备识别 | 通过 | 页面识别 1 台已授权 USB 手机 |
| scrcpy-server 启动 | 通过 | 固定 3.3.4，避免协议版本漂移 |
| H.264 视频编码 | 通过 | 手机硬件编码，20 FPS，4 Mbps |
| WebSocket 二进制转发 | 通过 | 服务端不解码、不转码 |
| 浏览器 WebCodecs 解码 | 通过 | 首轮为 328 x 720，清晰度优化后使用原生 720 x 1600 |
| 页面实时画面 | 通过 | 能看到 vivo 当前桌面 |
| 网页控制回传 | 通过 | 最近任务触发 Android recents input consumer |
| Home 控制 | 通过 | 返回 com.bbk.launcher2/.Launcher |
| 设备会话互斥 | 已实现 | 同一 serial 同时只允许一个会话 |

## 已确认的工程约束

- scrcpy-server 和协议解析库必须固定到相互兼容的版本。
- 第一版只使用 H.264，避免 H.265/AV1 浏览器兼容差异。
- 视频由手机编码，浏览器解码，Windows Agent 和云端只转发。
- 正式接入前必须补平台鉴权、短期 session token、设备权限、WSS 和审计。
- 远程控制会话必须复用现有设备锁，不能和扫码任务同时控制同一手机。
