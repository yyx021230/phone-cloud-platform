# 异步查名 rc.2：Node SDK超时修复补丁

本地候选，未上线或推送。只修复审查F4，不是完整平台源码；以不可变`lookup-async-20261013-rc.1`为基线，按VERSION.json中的overlayFiles覆盖客户端文件和接入包。服务端、调度、数据库、Agent、媒体及Python SDK均不变。

## 更新内容

- 单次HTTP超时覆盖连接、响应头和完整响应体，不在收到响应头后解除或重置计时。
- 2xx响应体超时/断包归类为network_error，提交最多重试1次；同次调用保持业务键，刷新Nonce/签名。GET失败由调用方下轮读取原lookupId，不新建查询。
- 已收到非2xx状态时，正文不可读也保留HTTP错误、不自动重提；完整正文仍保留业务code/payload。
- 接入ZIP中的Node客户端和SDK说明同步更新，OpenAPI、Python和其他条目保持原字节；SHA256清单同步。

默认异步单次尝试30秒；一次提交最多2次HTTP尝试，各有完整超时预算，因此不是整次调用固定30秒。HTTP超时不会取消服务器已受理任务。

## 复验

在项目工作区运行（仅合成数据和自建loopback HTTP，无真机）：

```sh
node --test releases/lookup-async-20261013-rc.2/sdk/open_name_lookup/*.test.mjs
python3 releases/lookup-async-20261013-rc.2/verification/verify-overlay.py
```

构建接入ZIP使用`verification/build-sdk-overlay.py`，从已验证rc.1包替换两个条目并重建内部/外部校验文件；可重复生成一致字节。测试允许通过`LOOKUP_SDK_UNDER_TEST`指定原SDK文件，用相同反例复核旧缺陷。

审查为自审；测试结果、基线、文件hash见VERSION.json、MANIFEST.json及[本轮回执](../../docs/evidence/LOOKUP_SDK_TIMEOUT_FIX_20261013.json)。旧rc.1及审查回执不改写。

## 剩余问题与回退

F1离线回收阻塞整池、F2准备完成撤权漏检、F3取消/到期与已收到成功结果竞态、F5旧同步入口推荐残留均未修。本候选不能据此认定平台已具备发布条件，ZIP仍是内部候选，不作正式接入交付。真实五台并发、自然触限切号及冷却到期也未新增验证。

回退范围只包含VERSION.json列出的客户端/接入包文件，使用不可变rc.1原文件及hash核对；无需迁移数据库或重启服务。SDK回退会恢复F4缺陷，业务键和原lookupId继续保留，不能通过新建请求补偿未知结果。生产部署仍须单独授权。
