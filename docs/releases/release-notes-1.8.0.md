# 服务端 1.8.0

新增 Windows / macOS 系统日历配置入口。macOS 使用 CalDAV 账户；新版和经典版 Outlook 使用 Microsoft 云端日历，可双向同步、暂停、重试并处理同时编辑的冲突。

Outlook 需要站长配置 `MICROSOFT_CALENDAR_CLIENT_ID`，详见[配置说明](../system-calendar-sync.md)。未配置时不会启用 Microsoft 连接。

包含数据库迁移 `0059_system_calendar_sync.sql`，保存加密凭据、同步关系及临时授权状态。升级前按现有流程备份数据库与 `.env`；服务启动后自动应用迁移，再启动同步任务。恢复备份后同步关系保持暂停，核对内容后手动恢复。

桌面客户端同步更新为 1.2.0，改进安装引导、顶部工具栏和深浅色界面。Mac 下载区分 Apple Silicon 与 Intel。桌面签名状态见[客户端发行说明](../../apps/desktop/RELEASE_NOTES.md)。

本版也包含此前主分支的 SSO 表单 CSRF 修复、安全与稳定性改进，以及将保存结果和一次性凭据移出网址的调整。
