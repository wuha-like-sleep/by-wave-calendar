# 桌面端 1.3.0

- 在 App 内连接 Outlook、选择日历、管理双向同步、暂停、恢复和处理冲突。Mac 的系统日历专用密码与日历范围也可在 App 内管理。
- 加快两个方向的删除同步：删除优先处理，回到前台主动刷新，前台每 15 秒刷新日程。完整同步优化需要服务端 1.9.0。
- 按旧版核对设置入口，保留账号、安全、设备、提醒、语言、外观与预约等功能，修复旧设置链接。
- 统一品牌图标，调整工具栏、侧栏、月历导航、设置布局和切换动画。
- 优化本地安装包压缩，减少下载体积；发布文件附 SHA-256 校验清单。

macOS Apple Silicon / Intel 安装包均使用 Developer ID 签名并通过 Apple 公证。
Windows x64 安装器尚无代码签名证书，会显示未验证发布者；已在本地 Windows 11 虚拟机验证旧版升级、全新安装、卸载和资料保留。

本次未发布新的 Linux 包，Linux 1.2.0 可继续从原发行版下载。系统日历及 Outlook 自身的刷新周期仍会影响最终显示。

下载：[GitHub](https://github.com/wuha-like-sleep/by-wave-calendar/releases/tag/desktop-v1.3.0) · [Gitee](https://gitee.com/zhaorunsen/by-wave-calendar/releases#release-desktop-v1.3.0)。

已安装用户可在 App 设置中检查更新。Outlook 需要平台管理员配置 Microsoft Entra 公共客户端 ID；完整的新同步控制与删除优化需要服务端 1.9.0。配置说明见 [系统日历同步](../../docs/system-calendar-sync.md)。

全部安装包在本机构建；GitHub Actions 保持停用。
