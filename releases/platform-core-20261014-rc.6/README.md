# platform-core-20261014-rc.6

本地候选，未部署。继承rc.5完整组合，修复Windows私有OCR DLL初始化顺序导致管道调用卡死；输入/结果/两帧OCR共享固定60秒，Agent查询/恢复外层65秒。递归滑块恢复保留原截止时间，不增加重输、重搜、切号或XML回退。启动/账号/共享ADB/投屏不变。

Windows独立受限目录离线安装、真实姓名卡单/双进程、超时回收和小红书WinRT实际入口通过；没有修改线上Agent、配置和Python。原生测试为Administrator SSH，不冒充SYSTEM或生产真机验收。Linux云组件继续沿用rc.2镜像原身份。用verification/prepare-local.py组装；本地API真机验收另记。
