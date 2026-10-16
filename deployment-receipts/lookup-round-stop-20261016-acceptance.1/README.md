# 结束本轮API：外部真机验收

已发布 `lookup-round-stop-20261016-deployed.1`，源码1940ec1 / 镜像4862080e。本轮业务全部使用公网普通HTTP及同一个X-API-Key，未用管理员接口伪造受理/停止/结果；管理员只读取证。真实Key仅从本机Keychain读取到内存，不进入文件/命令参数/回执。使用此前用户授权的测试表，索引104–115，共12条新业务请求。

## 实际验证

- 第一轮启动，155/162/156先就绪，公开ready:true；118/55登录失效退出，115/164探测继续，未等待异常手机。
- 第一条真实查询完成且有姓名。随后10条提交，外部GET实测3条processing、7条queued。
- 09:08:42Z结束本轮，HTTP202/stopping；7条排队立即取消、内部attempts为空；3条正在查和2条探测通过定向stop完成确认。09:09:08Z确认全轮stopped，耗时26.055秒；5条Windows stop任务均succeeded，未清锁假装停止。
- 停止进行中新prepare键HTTP409 lookup_round_stopping；排队取消和运行取消最终GET为failed/lookup_round_stopped，不伪装空姓名。已完成的第一条结果按原ID读取，名称摘要前后相同。
- 新prepare键获得不同preparationId并重新探测，至少两台就绪后ready:true；重试第一轮停止请求只返回第一轮stopped，第二轮ID与ready保持。第二轮新号码再次完成有姓名。
- 从线上下载、校验hash的stop_lookup.py两轮都实际调用通过；第二轮11.417秒确认stopped。再读相同prepare键仍stopped/ready:false，无新探测；两条已完成结果继续保留。
- 最后无查名通道、无在途请求、无执行任务；两轮已结束。池revision57不变，其他实时控制连接继续，未重载Agent或改ADB/SYSTEM。

39运行hash、10公网静态文件、完整Compose及env/镜像一致，主服务/Postgres/Redis healthy且0 restart；Agent有效实例心跳正常；最后有界300行日志未见所筛选的运行/持久化错误。D-075实际宿主live一致、媒体PID不变。865本地回归/7示例及隔离PG证据沿用已提交候选。

边界：停止中断线、停止中云端重启只在隔离HTTP/真实PG模拟验证，未在生产注入故障；原有普通异常耗尽/业务执行中账号掉线成功跨机的自然真机分支本轮没有新增证据。不把本功能通过称为整个生产平台绝对无故障。

本地日志收集曾在容器仍starting时过早解析最终部署JSON，出现一次采集解析错误；同窗口一次公开prepare响应未知。服务正常完成启动后继续同一准备键，没有新增重复业务。未因此改代码、重启额外服务或跳过校验。

`external-http.py` 为本轮实际生产调用记录工具，依赖本机已有安全登录/Keychain及授权号码源；不是离线测试，不应自动运行。其他回执均已脱敏，没有真实号码、姓名、Key或密码。
