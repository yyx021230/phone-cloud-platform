# platform-core-20261014-rc.3

本地查名搜索入口保护补丁；未发布。基于rc.2，小红书、接口、数据库及冻结投屏代码保持。

130首次启动失败的实际截图为浏览器权限页；旧搜索入口仅匹配“搜索框”描述。补丁限定支付宝包名，并在点击前及搜索就绪后复核前台。禁止根据其他应用或过期页面坐标继续输入。具体跳转来源未确认。

用户本轮确认只用118/130，五台真实并发不属于本轮验收；既有五路模拟结论保留。Windows原生测试仍缺独立测试环境，8小时自然到期待时钟推进。

复现：`python3 releases/platform-core-20261014-rc.3/verification/prepare-local.py --out /tmp/platform-core-rc3-review`，再运行输出目录的`verification/verify-candidate.py`。本地回退用rc.2重新组装，保留原数据库、请求和冷却，不恢复旧数据快照。
