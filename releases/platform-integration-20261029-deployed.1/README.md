# Phone Cloud 2026-10-29 上线回执

状态：已发布，生产完整验收尚未完成。分支codex/platform-release-prep-20261029；业务源码固定3a266d71（原platform-integration-20261029-rc.1），部署准备c800bf8（platform-integration-20261029-deploy-rc.1）。本目录由新的不可变annotated tag platform-integration-20261029-deployed.1绑定，后续不移动旧标签。

主云镜像a4db69c8、独立小红书批次be21335b；Agent20232由SYSTEM运行，共享ADB仍17764、SYSTEM、原二进制路径与10/28创建时间，原计划任务XML逐字节一致。23个Windows业务文件已最终对齐（22文件加漏项采集Python）。查名原prepare/配置/ID保留。临时门禁北京时间16:42:39–16:52:20，共9分41秒；Nginx原字节恢复，生产临时目录uid/gid/mode/inode无漂移，没有生产root nginx -t/-T。

## 实际打包故障及修正

首次镜像代码0600，batch以node运行时EACCES；新rc.2仅恢复29份非敏感业务源码0644，同内容hash不变，node用户无网络只读镜像内核对hash/import engine通过，仅重建独立batch，不再重启主云/Agent。不改变batch用户或私有配置权限。

原增量清单漏中文路径：Git人类可读输出对小红书数据同步.py引号转义，后缀筛选未收录，真机提交前hash门禁发现仍是旧cbf038e2。改为Git NUL分隔UTF-8路径，备份后原子补齐批准3a源码9a952261，无Agent/ADB重启。完整所选源/资产核对211项：云端110全匹配；Windows101项中96匹配、2冻结文件保持实际生产字节、3诊断/fixture不部署。两个native helper及三JAR也已核实，没有其他未解释的运行文件差异。工具runtime-file-manifest.py用于可复核清单，不宣称已实现自动CI/部署门禁。

screen-stream及serial-adb-health保留实际生产旧字节；不宣称相应候选大小写/错误分类修复上线，不把原候选整树回归等同该组合全手机真机通过。D-075前后均真实宿主live通过，媒体仍PID2503525、同binary hash、8Mbps/最多2包。

## 本轮线上验收

查名字：维护前19原业务全部终态，16 succeeded/3 not_found；切换后19项状态/queryId/结果摘要均不变。3原排队客户请求及1探测按原ID自然成功，恢复门禁后约41–57秒；原轮未stop、无重prepare，无新测试号码。这不覆盖stop-proof、超时/恢复全分支或全池真机吞吐。

小红书批次：新node实例healthy、零重启；公网签名GET200，未签名/错误签名/nonce重放均401；旧2批次无新增，daily全部5页100项和全部原job结果100/100一致，旧59成功41失败/970篇保留，不当作新版本成功率；100目标及02:00/并发5/240分钟原配置完全一致。

企微：GET设备200、141库存/8台在线、155两槽位、容量2及组件hash通过。最初无现有平台send job/claim，故不伪造原ID正向验收。本轮用户随后明确接收目标，具体43/main仅一次发送验收独立记录；完整号码不写本目录。

131/app1真实采集已通过：305150ms、28篇、主/反向与持久化一致、锁及恢复账本释放。43/main唯一邀请任务fd84ce2b在约233.5秒后failed，message=wecom_preview_worker_timeout_no_replay；cloud/local claim均无，sendStatus=not_attempted，没有发送。子进程退出、自有锁释放，原ID与证据保留，没有重试。17:28独立只读观察Poco/PocoTest均不在、目标转发0；当前停在系统双开选择器，只是失败后现象，不足以证明原生停点或根因。

已确认另一个独立缺陷：真实Agent的compactTaskResultForStatus漏企微结果字段，而旧端到端夹具直接提交status绕过该压缩边界，导致失败public code为空，也影响保存unknown/正常结果传输。该缺陷仍在本轮生产版本，独立最小修复候选由企微窗口准备，不以候选修复冒称230秒原生卡点已解决。未取得新的维护/手机尝试范围前，不再重启Agent或追加邀请。最终结构化证据见ACCEPTANCE.json。

## 仍未解决/未验证

readiness曾在16:54/16:55返回503，未保留当时失败子项，不能编造根因；16:56:49恢复200，17:08一次200耗时6.7秒，17:12一次8秒客户端超时，同窗观察到COPY和phone_cloud_state排他锁。代码确认快照TRUNCATE/COPY与readiness同表读取存在竞争可能，尚无完整等待链证明，不能归结为唯一根因或写已解决。健康容器不等同完整就绪/性能验收。

不以一台采集、三条查名或一次邀请推广为全手机/全分支通过。账号登录、历史153权限/131分身等旧缺口不在本轮扩围处理。按用户要求未追加本地功能验收；合成门禁/镜像权限/哈希校验仅为发布安全和完整性，不替代真机结果。

源/实际文件核对、组件回执、关键配置快照、私有证据哈希与应用回退材料均保留；未推送远端、未清理未知工作区或旧生产备份/数据。
