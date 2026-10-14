# platform-core-20261014-rc.2

查名、设备恢复和小红书数据采集的本地组合候选。**本地全量回归通过，未部署、未推送。** 本轮源提交以不可变 annotated tag 解析；父候选 rc.1 和所有历史标签保持。

- 基于 `platform-core-20261014-rc.1` 的完整生产比较链，合入 `xhs-data-automation-20261013-rc.5`（c91028cc），解决6处共用文件冲突。
- 保留快手、小红书自动登录/发布、查名双接口和恢复修复；新增采集任务、列表/详情/取消及独立文档栏目。
- Windows 查名 OCR 改为独立 Python venv 子进程，19个 wheel 锁定哈希；不在 Airtest 环境安装另一套 cv2。超时、父进程退出及无效回执会结束自己的 OCR 子进程。
- 小红书创建等持久化提交后才允许领取；保存失败不执行手机任务；无效结果先校验再更新状态。

本地验证：实际 Linux AMD64 Node 22 镜像全量 **697/697**、平台烟测；Agent **304/304**；Python **296/296**、执行器 **163/163**；恢复 **22/22**、SDK **6+9**。全量含 Agent 用例，计数有重叠。Postgres、JSON、121秒换请求号、五路 fake Agent、重启、取消/迟到结果、写入阻塞与失败回滚通过。独立 OCR 实际识别两帧，复用并回收子进程通过。API 页面已本地浏览验证，共46接口/9模块。

仍未验：Windows AMD64 原生DLL、本轮组合版真机、5台物理手机并发、新完整8小时冷却、148号映射；历史14条缺姓名卡证据不改成成功。上线窗口还需独立授权、生产漂移核对、D-075 live和灰度。

```sh
python3 releases/platform-core-20261014-rc.2/verification/prepare-local.py --out /tmp/platform-core-rc2-review
python3 /tmp/platform-core-rc2-review/verification/verify-candidate.py
```

组装仅写入指定的新本地目录，不启动业务。实际构建用该完整输出中的 Dockerfile（固定 Node 基础镜像摘要），不从根仓旧业务构建或重建投屏 bundle。更新/回退步骤和验收边界见 RELEASE_NOTES.md；机器回执见 verification/RESULTS.json、BUILD.json、FROZEN.json。
