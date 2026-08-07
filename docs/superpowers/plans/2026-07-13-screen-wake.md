# Screen Wake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 投屏建立后自动点亮 Android 屏幕，并提供手动唤醒按钮。

**Architecture:** 在现有 WebSocket 控制协议中增加 `key: wakeup`，服务端负责校验转发。Windows Agent 收到指令后通过 scrcpy 显式设置屏幕电源模式为 `Normal`，再注入 `KEYCODE_WAKEUP` 224。scrcpy 控制器就绪后自动执行一次，前端按钮复用相同指令。

**Tech Stack:** Node.js、ws、scrcpy、原生 HTML/CSS/JavaScript、node:test

## Global Constraints

- 不使用会切换亮灭状态的电源键。
- 不自动解锁手机。
- 自动唤醒失败不能终止视频流。

### Task 1: 协议和 Agent

**Files:** `server/screen-relay.mjs`、`server/screen-relay.test.mjs`、`windows-agent/src/screen-stream.mjs`、`windows-agent/src/screen-stream.test.mjs`

- [x] 先写失败测试，验证服务端接受 `wakeup`，Agent 映射到 224。
- [x] 实现协议校验、键值映射和控制器就绪后的自动唤醒。
- [x] 运行 `npm run test:screen`。

### Task 2: 前端按钮

**Files:** `public/index.html`、`public/app.js`、`public/styles.css`、`screen-client/main.js`

- [x] 增加“唤醒屏幕”按钮和连接状态规则。
- [x] 未连接时先建连，已连接时发送 `wakeup`。
- [x] 构建前端并更新缓存版本。

### Task 3: 部署验收

- [x] 部署 Windows Agent 和线上静态资源。
- [x] 熄屏真机启动投屏，验证屏幕自动亮起。
- [x] 运行完整检查与投屏回归测试。
