# Phone Cloud Scrcpy Web POC

隔离的实机投屏与远程控制验证，不接入现有平台任务、短信同步或 Airtest/Poco。

当前状态：已在 vivo V2442A / Android 14 真机完成视频和控制验证，详见 `VALIDATION.md`。

## 验证范围

- ADB 识别已授权 USB 手机。
- scrcpy-server 3.3.4 使用手机 MediaCodec 输出 H.264。
- Windows/Mac 执行器通过 WebSocket 转发编码帧。
- Chrome/Edge 使用 WebCodecs 解码到 canvas。
- 网页点击、拖动、返回、Home、最近任务通过 scrcpy 控制通道回传。
- 同一手机只允许一个控制会话。

## 启动

```bash
npm install
ADB_PATH=adb ANDROID_SERIAL=<设备序列号> npm run dev
```

默认地址：`http://127.0.0.1:8792`。

## 边界

- 当前仅监听本机，不提供公网访问。
- 当前没有平台登录、设备授权、短期会话 token 和审计。
- 当前不传音频，先验证视频和控制主链路。
- 正式接入必须由平台服务端签发短期会话，并通过 HTTPS/WSS 转发。

## 依赖与许可证

- scrcpy-server: Apache-2.0
- Tango/ya-webadb packages: MIT
- ws: MIT

验证目录不包含 GPL 的 ws-scrcpy-web 源码。
