# 支付宝查名接入包

版本 lookup-readiness-20261016-rc.16，实际部署与验收范围以同版本发布回执为准。

1. 后端环境配置管理员交付的HTTP BASE_URL、CLIENT_ID、CLIENT_SECRET。
2. 持久保存准备键；POST prepare / SDK prepareLookup、prepare_lookup，body只传{}。复用同一键每5秒读取，ready=true即可提交新号码；不返回设备数量，内部就绪条件和调度由平台管理。
3. 每个业务首次发送前保存业务键；submitLookup/submit_lookup只传手机号。
4. 保存lookupId，独立任务getLookupResult/get_lookup_result。status=completed才回填name：有名返回页面姓名，没名/未实名返回空字符串。
5. queued/processing没有name，继续轮询；failed、网络和HTTP错误不能当空姓名。两分钟超时复用ID/键，换键在途也合并；准备探测不进入业务缓存。

prepare是显式启用该客户端新结果格式的操作；未升级的其他客户端维持旧格式。准备30分钟固定有效，轮询不续期，expired后保存新准备键。服务重启/切号/掉线使就绪证据失效，后台重新验证。

`partner_example.py`提供持久SQLite示例。环境中的PHONE_NUMBER只供submit动作；凭据不存数据库，业务手机号/姓名须按自身权限管理。

```sh
python partner_example.py prepare --db private-demo.sqlite --preparation-key saved-preparation-key
python partner_example.py submit --db private-demo.sqlite --business-id your-stable-id
python partner_example.py poll --db private-demo.sqlite
```

这三个步骤由调用方按准备状态调度，示例不会隐式启动或在prepare未就绪时替你发送号码。GET重试不会执行查询。完整协议见OPEN_NAME_LOOKUP_API.md和openapi.json，解包后按SHA256.json验证。

每个clientId默认允许20条未完成业务（执行与排队合计，可由平台管理员调整）；可以并发提交10个或20个单号码请求。平台内部最多5台执行，只有2台就绪时其余请求排队，其他手机通过探测后自动接后续任务。哪条完成就单独返回，不等整批。达到配置上限的新号码返回429 lookup_inflight_limit且不创建任务，保留原业务键稍后重试；重复请求先防重、不额外占名额。客户端超时不会取消原任务或释放名额。

就绪状态会随手机当前情况变化；长时间无查询后平台会要求重新探测。若新提交返回503 lookup_not_ready，保留原业务键，用原准备键读取prepare直至ready后重试；已受理任务继续按原lookupId读取，不能把准备降级当作无姓名。准备轮次固定30分钟，反复读取不延长租期。


### 启动接口重试约定

同一轮尚未结束时，重复调用启动接口（包括更换准备键）只读取并复用这一轮，不清除账号掉线排除、不重复启动手机，也不延长15分钟空闲计时。需要登录授权的手机本轮不再分配；本轮结束后用新准备键启动，才重新探测。准备键重放保留24小时，从首次受理开始固定计时，轮询不续期；超过24小时不要重放旧键。新一轮必须使用新键。取消累计1000条的终身上限；每客户端每滚动分钟最多受理60个新准备键，超出返回429 lookup_preparation_rate_limit，等待60秒或继续使用已受理的原准备键。此限制不影响用原键轮询和读取原查询结果。准备键有效期与任务15分钟空闲结束规则是两个不同概念，业务手机号防重规则不变。
