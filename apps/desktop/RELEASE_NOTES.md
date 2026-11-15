# 桌面端 1.3.1（版本代码 28）

- 同时比较服务器和公开发布清单，选择有效的最高版本；网络失败一分钟后可以重试，手动检查随时可用。
- 更新检查合并并发请求，区分无法连接与已是最新版，拒绝缺少校验信息或不适用于当前系统的安装包。
- 事件缓存按账号隔离、原子写入，七天过期，最多保留 32 个日期窗口；事件变更后清理旧快照，避免切换视图时显示已删除的日程。
- 修复系统日历设置请求竞争、重复提交、旧请求覆盖新账号，以及保存成功后刷新失败时的反馈。

Mac Apple Silicon 和 Intel 安装包均在本机编译，使用既有 Developer ID 签名并通过 Apple 公证。Windows x64 安装包在本机 Windows 11 虚拟机编译；尚未签名，会显示未验证发布者。发布前验证 1.3.0 覆盖升级、全新安装、卸载、特殊路径、原生渲染与测试资料保留。

完整预约并发及取消修复需要服务端 1.9.1。本轮不发布新的 Linux 安装包。所有编译在本机完成；GitHub 免费标准 Ubuntu 运行器仅转传经过校验的现成文件到 Gitee。

下载：[GitHub](https://github.com/wuha-like-sleep/by-wave-calendar/releases/tag/desktop-v1.3.1) · [Gitee](https://gitee.com/zhaorunsen/by-wave-calendar/releases#release-desktop-v1.3.1)。
