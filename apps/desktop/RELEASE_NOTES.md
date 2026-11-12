# 桌面端 1.2.0

- 新增「设置 → 系统日历」：macOS 通过 CalDAV 接入系统日历；新版和经典版 Outlook 通过 Microsoft 账号的云端日历双向同步。
- 重做首次连接引导、顶部工具栏、视图切换、侧栏和设置卡片，统一深浅色与品牌图标。
- Mac 安装窗口加入拖入「应用程序」的引导；Windows MSI 使用统一的品牌侧栏、横幅与图标。
- 分别提供 Apple Silicon 和 Intel Mac 安装包，更新器按处理器架构选择；Windows 菜单快捷键使用 Ctrl。
- Mac 更新先复制和验证新应用，再替换旧应用，失败可回退；保留系统安全校验。

Outlook 需要站长先配置 Microsoft Entra 公共客户端 ID。同步的范围、冲突处理与配置步骤见仓库的 `docs/system-calendar-sync.md`。

Mac 补签发行（2026-11-13）：Apple Silicon 和 Intel 安装包均在本机重新构建，使用 Developer ID Application 签名并通过 Apple 公证；应用和 DMG 均附带公证票据，已验证 Gatekeeper 信任。请下载文件名以 `-signed.dmg` 结尾的安装包。

Mac 下载：[Apple Silicon](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.2.0/ByWaveCalendar-1.2.0-arm64-signed.dmg) · [Intel](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.2.0/ByWaveCalendar-1.2.0-x64-signed.dmg) · [SHA-256 校验值](https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v1.2.0/SHA256SUMS-macos-signed.txt)。

客户端版本仍为 1.2.0。已经安装 1.2.0 的用户可下载对应芯片的补签包，将应用拖入「应用程序」替换；相同版本不会再弹出版本升级提示，账户和数据保留在用户目录。旧附件保留原地址和校验值，以兼容尚未更新下载清单的服务器。

Windows 安装包仍未配置发行签名，可能显示未知发布者。后续构建、测试、签名和打包均在本地完成，GitHub 不再承担构建任务。
