# Phone Cloud MSE 投屏解码实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将正式投屏改为唯一的 MediaSource 原生 H.264 解码链路，在 HTTP 页面达到约 20 FPS，并删除所有旧解码器和自动降级分支。

**Architecture:** Windows Agent 继续输出 H.264 Baseline Annex-B 数据，服务端继续转发现有二进制包。浏览器使用 `h264-converter` 将视频数据封装为 fragmented MP4 并写入 `<video>` 的 MediaSource；控制消息仍通过现有 WebSocket 返回 Agent。

**Tech Stack:** JavaScript、MediaSource Extensions、HTMLVideoElement、h264-converter、Vite、Node test runner。

## Global Constraints

- 只使用 MediaSource 解码，不保留 WebCodecs、TinyH264 或自动降级。
- Agent 参数保持 `maxSize=1600`、`maxFps=20`、`videoBitRate=4Mbps`。
- 服务端 WebSocket 视频与控制协议保持兼容。
- 5 秒无首帧必须明确失败，不能显示已连接。
- 缓冲目标不超过约 300ms。

---

### Task 1: MSE 播放器行为测试

**Files:**
- Create: `screen-client/mse-player.js`
- Create: `screen-client/mse-player.test.mjs`
- Modify: `screen-client/screen-ui.test.mjs`
- Delete: `screen-client/decoder-selection.js`
- Delete: `screen-client/decoder-selection.test.mjs`

**Interfaces:**
- Produces: `MediaSourceScreenPlayer`，提供 `start()`, `write(Uint8Array)`, `stop()`，并通过 `onFirstFrame`、`onStats`、`onError` 回调报告状态。
- Consumes: `HTMLVideoElement`、`MediaSource.isTypeSupported()` 和 `h264-converter`。

- [ ] **Step 1: 写失败测试**

覆盖以下断言：唯一后端为 MSE；不支持 MSE 时抛出中文错误；首帧超时会失败；停止时清除定时器并释放 video；库存页面使用 `<video>` 而不是 `<canvas>`；CSP 不含 `wasm-unsafe-eval`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test screen-client/*.test.mjs`

Expected: FAIL，因为 `MediaSourceScreenPlayer` 尚不存在且页面仍为 canvas。

- [ ] **Step 3: 实现最小 MSE 播放器**

实现固定 MIME `video/mp4; codecs="avc1.42E01E"`，`VideoConverter(video, 20, 1)`，按收到顺序写入 Annex-B 数据。首个 `requestVideoFrameCallback` 或 `loadeddata` 触发 `onFirstFrame`；5 秒无首帧触发 `onError`。

- [ ] **Step 4: 运行单元测试**

Run: `node --test screen-client/*.test.mjs`

Expected: PASS。

### Task 2: 正式控制器迁移到单一 MSE 链路

**Files:**
- Modify: `screen-client/main.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: `MediaSourceScreenPlayer`。
- Produces: `new PhoneCloudScreenController({ video, wsUrl, ...callbacks })`，原有点击、滑动、返回、主页和最近任务方法保持不变。

- [ ] **Step 1: 更新控制器测试以要求 video 参数**

断言控制器不再引用 canvas、TinyH264 或 WebCodecs，并且只有首帧到达后才上报 live。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test screen-client/*.test.mjs`

Expected: FAIL，因为控制器仍构造旧解码器。

- [ ] **Step 3: 替换控制器和页面元素**

将二进制视频包经现有 `decodeVideoPacket()` 解析后写入 MSE 播放器；Agent live 仅表示通道就绪，首帧回调才通知页面“实时画面已连接”。指针映射使用 `video.videoWidth` 和 `video.videoHeight`。

- [ ] **Step 4: 加入低延迟监控**

每 250ms 检查 `video.buffered`；末端领先当前播放位置超过 0.3 秒时跳到 `end - 0.05`。用 `getVideoPlaybackQuality()` 计算 decoded、dropped 和 FPS。

- [ ] **Step 5: 运行前端测试**

Run: `node --test screen-client/*.test.mjs`

Expected: PASS。

### Task 3: 清理旧解码器和构建产物

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `server/index.mjs`
- Delete: `public/vendor/worker-Dm9DNeDt.js`
- Rebuild: `public/vendor/screen-control.js`

**Interfaces:**
- Adds runtime dependency: `h264-converter@0.1.4`。
- Removes runtime dependencies: `@yume-chan/scrcpy-decoder-tinyh264`、`@yume-chan/scrcpy-decoder-webcodecs`。

- [ ] **Step 1: 调整依赖**

Run: `npm uninstall @yume-chan/scrcpy-decoder-tinyh264 @yume-chan/scrcpy-decoder-webcodecs && npm install h264-converter@0.1.4`

Expected: lockfile 更新，旧解码包不再是直接依赖。

- [ ] **Step 2: 收紧 CSP 并删除 worker**

将 `script-src 'self' 'wasm-unsafe-eval'` 改为 `script-src 'self'`，删除 TinyH264 worker 构建产物。

- [ ] **Step 3: 构建浏览器包**

Run: `npm run build:screen`

Expected: `public/vendor/screen-control.js` 生成，且没有 TinyH264 worker。

- [ ] **Step 4: 运行完整静态检查**

Run: `npm run check`

Expected: PASS。

### Task 4: 部署与真机验收

**Files:**
- Deploy changed frontend bundle, HTML, app script, stylesheet, and server CSP to production.

**Interfaces:**
- Production URL: `http://47.98.127.132/`。
- Test device: `adb:10AEC80GHN007DR`。

- [ ] **Step 1: 部署正式环境并重启 Web 服务**

同步变更文件和依赖清单；重启 Phone Cloud Web 容器，确认 `/readyz` 返回成功。

- [ ] **Step 2: 验证首帧与清晰度**

普通用户进入设备详情，点击开始投屏；5 秒内 `<video>` 的 `videoWidth/videoHeight` 必须为 `712x1600`，页面不可出现黑屏或“已连接但无首帧”。

- [ ] **Step 3: 验证动态帧率和延迟**

连续滑动手机页面，读取 `getVideoPlaybackQuality()`；动态 FPS 应接近采集上限 20 FPS，buffered 领先值保持约 300ms 内。

- [ ] **Step 4: 验证控制与资源释放**

验证点击、滑动、返回、主页和最近任务；停止投屏后 WebSocket 关闭、video 资源释放、设备投屏锁释放。

