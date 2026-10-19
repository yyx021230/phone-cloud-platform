# 支付宝查名接入包

版本 lookup-readiness-20261016-rc.16，实际部署与验收范围以同版本发布回执为准。

1. 后端环境配置管理员交付的HTTP BASE_URL、CLIENT_ID、CLIENT_SECRET。
2. 持久保存准备键；POST prepare / SDK prepareLookup、prepare_lookup，body只传{}。复用同一键每5秒读取，ready=true即可提交新号码；不返回设备数量，内部就绪条件和调度由平台管理。
3. 每个业务首次发送前保存业务键；submitLookup/submit_lookup只传手机号。
4. 保存lookupId，独立任务getLookupResult/get_lookup_result。status=completed才回填name：有名返回页面姓名，没名/未实名返回空字符串。
5. queued/processing没有name，继续轮询；failed、网络和HTTP错误不能当空姓名。两分钟超时复用ID/键，换键在途也合并；准备探测不进入业务缓存。

prepare是显式启用该客户端新结果格式的操作；未升级的其他客户端维持旧格式。本轮没有未完成业务查询，并连续10分钟没有新受理查询时自动结束。排队、执行、人工等待、恢复和未知执行仍属未完成业务，不会因空闲计时中断；最后一条业务结束后重新计10分钟。只启动未提交业务时，从启动开始计时；后台探测不续期。GET、prepare轮询（含换准备键）、同键重试和命中已有任务/缓存的重提均不续期。空闲到期走安全停止：可能短暂expired，随后stopping，收到手机停止确认才stopped；未确认时不释放占用、不启动下一轮。确认stopped后，由调用方用新的准备键显式启动。已完成结果继续保留。服务重启/切号/掉线使就绪证据失效，后台重新验证。

`partner_example.py`提供持久SQLite示例。环境中的PHONE_NUMBER只供submit动作；凭据不存数据库，业务手机号/姓名须按自身权限管理。

```sh
python partner_example.py prepare --db private-demo.sqlite --preparation-key saved-preparation-key
python partner_example.py submit --db private-demo.sqlite --business-id your-stable-id
python partner_example.py poll --db private-demo.sqlite
```

这三个步骤由调用方按准备状态调度，示例不会隐式启动或在prepare未就绪时替你发送号码。GET重试不会执行查询。完整协议见OPEN_NAME_LOOKUP_API.md和openapi.json，解包后按SHA256.json验证。

每个clientId默认允许20条未完成业务（执行与排队合计，可由平台管理员调整）；可以并发提交10个或20个单号码请求。平台内部最多5台执行，只有2台就绪时其余请求排队，其他手机通过探测后自动接后续任务。哪条完成就单独返回，不等整批。达到配置上限的新号码返回429 lookup_inflight_limit且不创建任务，保留原业务键稍后重试；重复请求先防重、不额外占名额。客户端超时不会取消原任务或释放名额。

就绪状态会随手机当前情况变化；长时间无查询后平台会要求重新探测。若新提交返回503 lookup_not_ready，保留原业务键，用原准备键读取prepare直至ready后重试；已受理任务继续按原lookupId读取，不能把准备降级当作无姓名。本轮没有未完成业务查询，并连续10分钟没有新受理查询时自动结束。排队、执行、人工等待、恢复和未知执行仍属未完成业务，不会因空闲计时中断；最后一条业务结束后重新计10分钟。只启动未提交业务时，从启动开始计时；后台探测不续期。GET、prepare轮询（含换准备键）、同键重试和命中已有任务/缓存的重提均不续期。空闲到期走安全停止：可能短暂expired，随后stopping，收到手机停止确认才stopped；未确认时不释放占用、不启动下一轮。确认stopped后，由调用方用新的准备键显式启动。已完成结果继续保留。


空闲截止字段：当前空闲截止时间（UTC ISO 8601）；有未完成业务时为null，表示空闲计时暂停。以status和ready判断状态，不把null当已过期。
