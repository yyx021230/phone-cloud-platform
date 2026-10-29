# 查名失败取证隔离候选 rc.9

仅本地候选，未上线/推送。父提交 d0a5492282fdf1d742de4a0b8885f1510ee39fe2 / lookup-throughput-20261028-rc.8；继承此前候选，不移动旧标签。

## 确认的问题与最小改动

真实runTask错误路径在captureFailureEvidence中无条件启动独立uiautomator dump，即使Poco的手机端instrumentation可能仍驻留。包括alipay_name_stop清理失败也会继续发focus/XML/screenshot命令，违背停止只清理的边界。本候选仅修改这个取证函数：

- 查名start/query/switch失败保留既有焦点和截图，不再启动独立XML读取器；不因host Map不存在推断手机端已结束。
- 查名stop失败不追加任何取证手机命令，保留原始清理错误和rc.7计量。
- 非查名仍按原焦点/XML/截图取证。没有新增diagnostic合并或覆盖，没有修改姓名/空值判断、AI提示、API结果、调度或投屏。

去掉了查名失败路径一次最长15秒的独立XML取证等待；没有据此给出业务吞吐提升百分比。

## 验证

完整1608项Node回归（含投屏）和根check通过。

实际runTask→captureFailureEvidence→finish/status的6项故障组合测试：三类查名不另启XML、stop零额外命令、截图/焦点失败保留原错误、非查名行为不变。协作独立复核22项（含计量和stop证明）通过。

14:25只读真机52：调用候选真实captureFailureEvidence(query)，dumpsys window 328ms、screencap 1922ms，获取1080×2400 PNG；未发XML、输入、点击或新号码，随后captureFailureEvidence(stop)零额外手机命令。数字为Windows命令耗时，不含SSH/租约往返；这是取证分支验收，不是完整API业务验收。测试占用随后已释放。

前一轮完整API51/52的首次RPC/普通命令停滞未解决，本轮0业务、164仍生产占用。那轮SSH适配器未调用通用取证函数，因此不能将本修复写成那次最初超时根因。详见rc.8/REAL_DEVICE.md。

## 回退与边界

只读核对生产ACTIVE SHA256仍4bb61c39a8a5cd912069ed494d84dba1af4cf3cc37adbac8285db935586b995a，镜像fca45ec3运行零重启；共享ADB17764与Agent26488仍SYSTEM和原路径。没有修改线上Agent、数据/配置、ADB、身份、Windows、USB、媒体或宿主机。回退代码点rc.8；正式发布仍需具体版本和影响窗口授权、完整备份/回执及冻结基线核验。
