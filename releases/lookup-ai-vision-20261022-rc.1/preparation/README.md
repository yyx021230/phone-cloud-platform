# 已备好，尚未切换

运行候选提交 `fef7ff801c4fa8c391f0ae35a9f47ed6db3e8e76` / annotated tag `lookup-ai-vision-20261022-rc.1`。新镜像 `35cba1db05e126adf48acaa63241772854b7069559fd054459d74699a49a74ff`，从原线上镜像最小叠加6个文件。

数据库681MB完整dump及pg_restore目录核验、63MB旧镜像归档、ACTIVE/Compose/对应源文件备份已完成。准确字节校验以PREPARATION_RECEIPT.json为准。生产mode临时网络隔离PostgreSQL镜像启动烟测通过；额外启动独立临时容器，加载正式密钥只读挂载，合成无姓名图经实际模型4458ms返回现有空值，120秒配置核对通过。临时容器已销毁；无手机操作或生产任务数据修改。

D-075真实宿主机live通过；共享ADB listener5037仍PID8988、SYSTEM、既有路径；Agent只读CIM仍PID5176/SYSTEM。第一次CIM枚举包含已退出瞬时客户端造成owner读取错误，随后直接核验监听PID成功；未执行任何ADB客户端命令。原业务容器健康、零重启。

16:55（Asia/Shanghai）只读快照：没有活动查名/业务任务，182/161两路控屏在用。已向用户请求本次约2分钟控屏中断窗口（包含窗口新连接），尚未执行切换。维护前重新检查实际占用，不将本快照当成未来空闲授权。

部署入口是已提交的deployment/activate-cloud.py，只有取得本次中断窗口确认后才传 `--approved-control-window`；它核对基线/备份/Compose差异和当前业务占用，失败回滚旧Compose/镜像并恢复ACTIVE，不恢复数据库覆盖新数据。运行代码使用候选提交，操作脚本回执使用后续独立提交，旧标签不移动。生产真机效果尚未验收。
