# 支付宝查名接入包

版本 lookup-readiness-20261015-rc.1，本地候选，尚未上线。

1. 后端环境配置管理员交付的HTTP BASE_URL、CLIENT_ID、CLIENT_SECRET。
2. 持久保存准备键；POST prepare / SDK prepareLookup、prepare_lookup，body只传{}。复用同一键每5秒读取，ready=true即可提交新号码；至少2台就绪，后台补到5台。
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
