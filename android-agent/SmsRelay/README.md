# SmsRelay Android 客户端

`com.ztqc.smsrelay` 是 Phone Cloud 的 Android 短信客户端。它可以申请成为默认短信应用，将文字短信先写入本地持久化存储，再异步同步到平台；网络失败不会删除本地消息。

## 能力

- 会话列表、搜索、未读状态、验证码复制和短信收发；
- 双卡信息与卡槽映射；
- 本地消息、系统短信 Provider 和上传队列分离；
- 失败重试、开机恢复、健康状态查询和精确恢复入口；
- 可选的扫码辅助无障碍服务。

当前只完整支持文字短信。清单中声明了彩信接收组件以满足默认短信角色要求，但尚未实现彩信正文下载和展示。

## 构建

准备 JDK、Android SDK 后执行：

```bash
./gradlew clean assembleDebug
```

仓库不包含生产签名私钥。正式发布必须使用独立、受控且可备份的签名资产；不要把 keystore、密码或真实中台地址提交到仓库。

## 配置与健康检查

服务端地址和设备令牌通过应用配置写入，不应硬编码生产值。Windows Agent 可对已授权设备查询健康 Provider，或启动受 `android.permission.DUMP` 保护的恢复 Activity：

```text
content://com.ztqc.smsrelay.health/status
com.ztqc.smsrelay/.RecoveryActivity
```

任何批量安装、切换默认短信应用或读取真实短信内容的操作，都应先获得设备所有者授权并在指定测试设备完成验证。
