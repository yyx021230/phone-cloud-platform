# 回退边界

当前未发布，线上没有本轮回退动作。独立测试进程已退出，不动共享Agent/ADB。

本候选两份运行增量是 `windows-agent/scripts/alipay_name_lookup.py` 和 `windows-agent/src/index.mjs`；回退到父rc.4完整组合对应文件，按BASELINE.before核对哈希，不能回退rc.1–4其他修复。测试文件不部署到运行目录。

正式组合发布前须对当时实际运行文件、镜像、数据库、配置重新备份，保存具体已提交版本、哈希及部署回执。Agent函数与Python必须作为已测试组合更新；是否需重载共享Agent及影响范围须按实际发布方案确认。当前没有取得本轮共享服务切换维护窗口，不能以此前批准的维护替代。

不包含ADB/SYSTEM/密钥/驱动/Windows/USB/媒体重启或变更；D-075生产live核验不通过时停发，不自行修复。
