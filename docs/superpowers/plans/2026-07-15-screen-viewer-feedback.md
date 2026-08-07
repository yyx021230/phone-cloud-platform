# 实时投屏画面内反馈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在实时投屏开始、准备和失败时，把明确反馈展示在手机画面中央。

**Architecture:** 在现有手机画面容器内增加状态遮罩层，由 `renderUserScreenControl` 根据既有会话状态切换显示内容。首帧状态隐藏遮罩，失败状态提供同一入口的重连动作。

**Tech Stack:** 原生 HTML、CSS、浏览器 JavaScript、Node 内置测试。

## Global Constraints

- 不修改服务端投屏 API、会话状态机和控制输入协议。
- 使用现有 `userScreenStatus`、`userScreenDetail`、`startUserScreenSession` 状态与函数。
- 桌面和移动端的状态提示必须位于手机画面中心，文案不溢出。

---

### Task 1: 画面内状态层

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: `state.userScreenStatus`、`state.userScreenDetail`、`startUserScreenSession()`。
- Produces: `.screen-viewer-overlay` 的 `data-state` 和可见性，及 `userScreenReconnectButton` 点击重连。

- [ ] **Step 1: 新增状态层 DOM**

在 `#userScreenVideo` 后增加状态遮罩，包含加载环、状态文案和失败时可见的重连按钮。

- [ ] **Step 2: 依据会话状态渲染遮罩**

`connecting`、`preparing`、`ready` 显示加载状态；`live`、`streaming` 隐藏；`failed` 显示失败原因与重连按钮；`idle` 继续使用既有空状态。

- [ ] **Step 3: 增加居中样式和移动端约束**

遮罩绝对定位在 `.screen-device-shell` 内，以深色半透明背景承托加载环和文案；失败状态使用现有红色语义色。

- [ ] **Step 4: 验证**

运行 `npm run check`，并打开投屏页面确认状态层不会覆盖已连接的实时画面。
