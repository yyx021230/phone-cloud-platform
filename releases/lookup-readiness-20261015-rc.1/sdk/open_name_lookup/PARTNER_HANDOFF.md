# 合作方交接检查

本包lookup-readiness-20261015-rc.1未上线。管理员确认部署与设备池开放后使用；当前线上不能调用新prepare接口。

需要单独交付：HTTP BASE_URL、clientId、secret；平台内部配置已授权且已知有姓名的探测号码，不交给调用方。新Agent支持lookupRuntimeId才能出具本轮准备证明。至少2台通过就绪，后台目标5台，真实测试范围由平台另行确认。

流程：prepare（{}，持久准备键）→ready→tasks（phoneNumber，持久业务键）→按lookupId GET。每条完成立即回填name，未实名为空；处理中不回填空，服务错误不当空。准备任务和手机号业务是两类ID/键。

合作方至少测试：真实签名；准备仅1台时503、2台时可提交；两分钟后换键仍原ID；响应丢失重试；一个号码先完成就先保存；姓名/空姓名；GET失败不重提；回填失败重读；准备过期新键、账号掉线后准备降级。五台模拟不是五台真机。

SDK默认每次HTTP30秒，POST网络错误最多再试1次且复用键；每次新Nonce/签名。保存name需同时满足ok=true与status=completed。旧客户端没调用prepare时仍有succeeded/not_found/failed，新示例兼容旧完成态；不要在一个clientId下混用旧解析器与新prepare流程。

本地和生产证据以版本回执为准；本包不含真实手机号、密钥、姓名或服务器登录信息。没有改变媒体、ADB、USB或投屏参数的授权。
