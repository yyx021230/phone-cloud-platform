# Phone Cloud MediaSource 投屏解码设计

## 目标

正式投屏统一使用 MediaSource Extensions（MSE）和浏览器原生 H.264 解码器，在当前 HTTP 部署下保持 `712x1600` 画质，并将动态画面稳定在当前采集上限约 20 FPS。

本次不保留 WebCodecs、TinyH264 或自动降级路径。MSE 不可用或解码失败时，页面直接显示明确错误，避免出现“已连接但低帧率”或静默切换到软件解码。

## 数据流

1. Windows Agent 继续通过 scrcpy 采集 H.264 Baseline 视频，配置保持 `maxSize=1600`、`maxFps=20`、`videoBitRate=4Mbps`。
2. 服务端继续原样转发配置包、关键帧和普通视频包，不改变现有 WebSocket 协议、设备锁和控制消息。
3. 浏览器使用 `h264-converter` 将 Annex-B H.264 NALU 封装为碎片化 MP4，并写入 MediaSource。
4. `<video muted autoplay playsinline>` 使用浏览器原生视频解码能力播放画面。
5. 点击、滑动和系统导航继续通过现有 WebSocket 控制通道发送，坐标按 `videoWidth/videoHeight` 换算。

## 前端结构

- 将设备详情中的投屏 `<canvas>` 替换为 `<video>`。
- `PhoneCloudScreenController` 只维护一种 `MediaSource` 解码器。
- 每个 H.264 包进入单一写入队列，避免 SourceBuffer 并发更新。
- 每帧一个片段，优先低延迟。
- 持续监控播放缓冲；缓冲超过约 300ms 时跳到最新位置，防止操作画面逐渐落后。
- 使用 `getVideoPlaybackQuality()` 记录已解码帧、丢帧和实时 FPS，供后续诊断使用。
- 收到首个可播放帧后才将状态改为“实时画面已连接”；不能再仅凭 Agent 已连接隐藏占位层。

## 清理范围

- 删除 `@yume-chan/scrcpy-decoder-tinyh264`。
- 删除 `@yume-chan/scrcpy-decoder-webcodecs`。
- 删除 TinyH264 worker 构建产物和 worker 路径测试。
- 删除 CSP 中仅为 TinyH264 WASM 增加的 `'wasm-unsafe-eval'`。
- 保留 `@yume-chan/scrcpy`，因为视频包格式和控制协议仍使用它。

## 失败处理

- 浏览器不支持 `MediaSource` 或不支持 `video/mp4; codecs="avc1.42E01E"`：直接提示“当前浏览器不支持实时投屏”。
- SourceBuffer、视频解码或播放失败：终止当前投屏会话并显示具体错误。
- 5 秒内没有首帧：显示“已连接执行器，但未收到可播放画面”，不显示为投屏成功。
- 不自动切换任何其他解码器。

## 验收标准

- 从正式用户设备详情点击“开始投屏”，5 秒内显示真实手机画面。
- 设备 92 动态画面约 20 FPS，保持 `712x1600`。
- 点击、滑动、返回、主页、最近任务均可用。
- 连续控制 2 分钟，播放延迟不持续增长，缓冲保持在约 300ms 内。
- 投屏结束后释放设备锁和浏览器/MediaSource 资源。
- 构建产物不再包含 TinyH264 worker，线上 CSP 不再开放 WASM 编译权限。
