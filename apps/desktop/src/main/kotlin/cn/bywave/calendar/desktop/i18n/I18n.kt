// Compose Desktop i18n. Mirrors src/lib/i18n.ts on the web side:
// flat key → string dictionaries per locale, English as the canonical
// "source of truth" (missing keys fall back to English, then to the
// key itself for greppability).
//
// Persistence: ~/.bywave-calendar/locale (plain text, single line, the
// locale code). Survives upgrades. Read once at app boot via init().
//
// Usage from Composables:
//
//   @Composable
//   fun MyScreen() {
//       val locale by I18n.current.collectAsState()
//       Text(I18n.t("nav.settings"))    // reactive via `locale`
//   }
//
// The `locale by collectAsState()` line is critical even if you don't
// reference `locale` — Compose needs it to know the @Composable
// depends on I18n.current. Without it, switching language doesn't
// re-render.
//
// Adding a language:
//   1. Add an entry to Locale enum
//   2. Add a dictionary map below
//   3. Translate the keys you have; missing ones inherit English

package cn.bywave.calendar.desktop.i18n

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

object I18n {

    enum class Locale(val code: String, val label: String) {
        ZH_CN("zh-CN", "简体中文"),
        ZH_TW("zh-TW", "繁體中文"),
        EN("en", "English"),
        JA("ja", "日本語"),
        KO("ko", "한국어"),
        ES("es", "Español"),
        FR("fr", "Français"),
        DE("de", "Deutsch"),
    }

    val all: List<Locale> = Locale.entries.toList()

    private val storeDir: Path = Paths.get(System.getProperty("user.home"), ".bywave-calendar")
    private val storeFile: Path = storeDir.resolve("locale")

    private val _current = MutableStateFlow(Locale.ZH_CN)
    val current: StateFlow<Locale> = _current.asStateFlow()

    /** Call once at app boot before any Compose tree mounts. Picks up
     *  the user's previous choice from disk; falls back to JVM system
     *  language ("en" → EN, anything else → ZH_CN). */
    fun init() {
        runCatching {
            if (Files.exists(storeFile)) {
                val code = Files.readString(storeFile).trim()
                val match = all.firstOrNull { it.code == code }
                if (match != null) {
                    _current.value = match
                    return
                }
            }
        }
        // No saved preference — sniff JVM default. Apple devices often
        // report "en" / "en-US" / "zh-CN" / "zh-Hans-CN" etc.; we only
        // distinguish English vs everything else (treating everything
        // else as Chinese, since that's the project's primary audience).
        val sys = java.util.Locale.getDefault().language ?: "zh"
        _current.value = if (sys.startsWith("en")) Locale.EN else Locale.ZH_CN
    }

    /** Switch UI language. Persists to disk so the choice survives
     *  app restarts. The Compose tree re-renders automatically via
     *  the StateFlow. */
    fun setLocale(loc: Locale) {
        if (_current.value == loc) return
        _current.value = loc
        runCatching {
            Files.createDirectories(storeDir)
            Files.writeString(storeFile, loc.code)
        }.onFailure {
            // Persistence failure isn't fatal — language still switches
            // for this session. Log to stderr; next launch reverts.
            System.err.println("[I18n] failed to persist locale: ${it.message}")
        }
    }

    /** Translate a key. Falls back to English, then to the key itself.
     *  Optional `vars` substitutes `{name}` placeholders. */
    fun t(key: String, vars: Map<String, Any>? = null): String {
        val dict = DICTIONARIES[_current.value] ?: DICTIONARIES[Locale.EN]!!
        var value = dict[key] ?: DICTIONARIES[Locale.EN]?.get(key) ?: key
        if (vars != null) {
            for ((k, v) in vars) value = value.replace("{$k}", v.toString())
        }
        return value
    }

    // -------- Dictionaries --------

    private val en: Map<String, String> = mapOf(
        // App-level
        "app.name" to "ByWave Calendar",

        // TopBar / nav
        "topbar.today" to "Today",
        "topbar.prevDay" to "Previous day",
        "topbar.prevWeek" to "Previous week",
        "topbar.prevMonth" to "Previous month",
        "topbar.nextDay" to "Next day",
        "topbar.nextWeek" to "Next week",
        "topbar.nextMonth" to "Next month",
        "topbar.refresh" to "Refresh",
        "topbar.new" to "New event",
        "topbar.search" to "Search",
        "topbar.settings" to "Settings",
        "viewmode.day" to "Day",
        "viewmode.week" to "Week",
        "viewmode.month" to "Month",

        // MenuBar (macOS)
        "menu.appGroup" to "ByWave Calendar",
        "menu.showWindow" to "Show Window",
        "menu.settings" to "Settings…",
        "menu.checkUpdate" to "Check for Updates…",
        "menu.quit" to "Quit ByWave Calendar",

        // Settings shell
        "settings.title" to "Settings",
        "settings.close" to "Close settings",
        "settings.tabAccount" to "Account",
        "settings.tabCalendars" to "Calendars",
        "settings.tabSecurity" to "Security",
        "settings.tabAppearance" to "Appearance",
        "settings.tabAbout" to "About",

        // Settings — Account
        "settings.account.title" to "Account",
        "settings.account.email" to "Email",
        "settings.account.displayName" to "Display name",
        "settings.account.server" to "Server",
        "settings.account.deviceId" to "Device ID",
        "settings.profileMgmt.title" to "Manage accounts",
        "settings.profileMgmt.desc" to "Switch / add / remove ByWave servers. Each profile is its own server + user pair.",
        "settings.profileMgmt.switch" to "Switch",
        "settings.profileMgmt.remove" to "Remove",
        "settings.profileMgmt.addServer" to "+ Add server",
        "settings.signOut.title" to "Sign out of current account",
        "settings.signOut.desc" to "Signing out keeps cached event data locally. Signing back in with the same account picks up where you left off.",
        "settings.signOut.button" to "Sign out of current account",

        // Settings — Calendars
        "settings.calendars.title" to "My calendars",
        "settings.calendars.desc" to "Create, rename, recolor, change timezone, or delete your calendars right here.",
        "settings.calendars.empty" to "No calendars yet.",
        "settings.calendars.openOnWeb" to "Manage calendars on the web",
        // Settings — Calendars (management — added when desktop went read/write)
        "settings.calendars.new" to "+ New calendar",
        "settings.calendars.edit" to "Edit",
        "settings.calendars.delete" to "Delete",
        "settings.calendars.share" to "Share links",
        "settings.calendars.createTitle" to "New calendar",
        "settings.calendars.editTitle" to "Edit calendar",
        "settings.calendars.nameLabel" to "Name",
        "settings.calendars.colorLabel" to "Color",
        "settings.calendars.timezoneLabel" to "Timezone",
        "settings.calendars.descLabel" to "Description",
        "settings.calendars.create" to "Create",
        "settings.calendars.save" to "Save",
        "settings.calendars.cancel" to "Cancel",
        // Delete confirm — the warning MUST make the cascade explicit:
        // deleting a calendar drops all of its events server-side.
        "settings.calendars.deleteTitle" to "Delete calendar?",
        "settings.calendars.deleteWarning" to "This permanently deletes \"{name}\" and ALL of its events. This cannot be undone.",
        "settings.calendars.deleteConfirm" to "Delete calendar",

        // Settings — Calendars / share (subscribe) links
        "settings.share.title" to "Share \"{name}\"",
        "settings.share.intro" to "Generate a read-only subscribe link (.ics). Anyone with the link can subscribe in their calendar app. Revoke a link any time to cut off access.",
        "settings.share.labelPlaceholder" to "Label (optional)",
        "settings.share.generate" to "Generate link",
        "settings.share.generateFailed" to "Couldn't generate the link.",
        "settings.share.loading" to "Loading links…",
        "settings.share.loadFailed" to "Couldn't load share links.",
        "settings.share.empty" to "No share links yet.",
        "settings.share.unnamed" to "(unnamed)",
        "settings.share.copy" to "Copy link",
        "settings.share.copied" to "Copied",
        "settings.share.revoke" to "Revoke",
        "settings.share.revokeTitle" to "Revoke link?",
        "settings.share.revokeConfirm" to "Anyone still subscribed to this link will stop receiving updates. This can't be undone.",
        "settings.share.revokeFailed" to "Couldn't revoke the link.",
        "settings.share.close" to "Done",

        // Global search dialog
        "search.title" to "Search events",
        "search.placeholder" to "Title / description / location",
        "search.hint" to "Type to search across all your calendars.",
        "search.searching" to "Searching…",
        "search.empty" to "No matches.",
        "search.failed" to "Search failed.",
        "search.close" to "Close",

        // Settings — Security
        "settings.security.title" to "Security",
        "settings.security.desc" to "Sensitive actions (change password / Passkey / MFA / delete account) open on the web — the desktop hands you a one-time token so you don't have to re-enter your password.",
        "settings.security.changePassword" to "Change password",
        "settings.security.changePassword.sub" to "Requires current password",
        "settings.security.passkey" to "Passkey",
        "settings.security.passkey.sub" to "Add / rename / revoke",
        "settings.security.mfa" to "Two-factor (TOTP)",
        "settings.security.mfa.sub" to "MFA / backup codes",
        "settings.security.devices" to "My devices",
        "settings.security.devices.sub" to "View / revoke other sessions",
        "settings.security.loginHistory" to "Login history",
        "settings.security.loginHistory.sub" to "Last 100 sign-ins",
        "settings.security.danger" to "Danger zone",
        "settings.security.deleteAccount" to "Delete account",
        "settings.security.deleteAccount.sub" to "Permanent — proceed carefully",

        // Settings — Security / native change-password dialog
        "settings.security.changePassword.title" to "Change password",
        "settings.security.changePassword.current" to "Current password",
        "settings.security.changePassword.new" to "New password",
        "settings.security.changePassword.confirm" to "Confirm new password",
        "settings.security.changePassword.hint" to "New password must be at least 8 characters.",
        "settings.security.changePassword.submit" to "Change password",
        "settings.security.changePassword.cancel" to "Cancel",
        "settings.security.changePassword.close" to "Close",
        "settings.security.changePassword.mismatch" to "The two new passwords don't match.",
        "settings.security.changePassword.success" to "Password changed.",
        "settings.security.changePassword.otherSessions" to "For your security, all other signed-in sessions were signed out. This device stays signed in.",
        "settings.security.changePassword.failed" to "Couldn't change the password.",

        // Settings — Security / native devices list
        "settings.devices.title" to "My devices",
        "settings.devices.desc" to "Devices and apps paired with your account. Revoke any you don't recognize.",
        "settings.devices.loading" to "Loading devices…",
        "settings.devices.empty" to "No paired devices.",
        "settings.devices.thisDevice" to "This device",
        "settings.devices.lastSeen" to "last seen {when}",
        "settings.devices.revoke" to "Revoke",
        "settings.devices.revokeTitle" to "Revoke device?",
        "settings.devices.revokeConfirm" to "Sign \"{label}\" out? It will need to pair again to sync.",
        "settings.devices.revokeFailed" to "Couldn't revoke the device.",
        "settings.devices.loadFailed" to "Couldn't load your devices.",

        // Settings — Appearance
        "settings.appearance.title" to "Appearance",
        "settings.appearance.desc" to "Theme / palette / density are stored per account. Pick on the web once and they sync next time the desktop signs in.",
        "settings.appearance.openOnWeb" to "Pick theme on the web",

        // Settings — Appearance / Language
        "settings.language.title" to "Language",
        "settings.language.desc" to "Desktop UI language. Applies to all profiles on this computer.",

        // Settings — About
        "settings.about.title" to "About",
        "settings.about.app" to "Application",
        "settings.about.version" to "Version",
        "settings.about.server" to "Server",
        "settings.about.license" to "License",
        "settings.about.copyright" to "Copyright",
        "settings.about.checkUpdate" to "Check for updates",
        "settings.about.github" to "GitHub",
        "settings.about.tagline" to "ByWave Calendar is a self-hosted calendar sharing platform. The desktop client is built with Compose Multiplatform — one Kotlin codebase ships to Mac / Windows / Linux.",

        // Open-in-web row
        "openInWeb.openFailed" to "Failed to open the browser",
        "openInWeb.openFailed.title" to "Couldn't open",
        "openInWeb.ok" to "OK",
        "openInWeb.openInBrowser" to "Open in browser",

        // Update dialog
        "update.title" to "New version available",
        "update.installed" to "Currently installed",
        "update.latest" to "Latest",
        "update.releaseNotes" to "What's new",
        "update.downloadButton" to "Download & install",
        "update.downloading" to "Downloading…",
        "update.openInFinder" to "Open in Finder",
        "update.notNow" to "Not now",
        "update.upToDate.title" to "You're up to date",
        "update.upToDate.body" to "You're already running the latest version (v{version}).",
        "update.upToDate.checking" to "Checking for updates…",
        "update.upToDate.button" to "OK",

        // Sidebar / profile switcher
        "sidebar.calendars" to "Calendars",
        "sidebar.empty" to "(no calendars)",

        // Error banner
        "error.retry" to "Retry",

        // Setup screen (first launch)
        "setup.title" to "Connect to your ByWave server",
        "setup.serverUrl" to "Server URL",
        "setup.scanButton" to "Show pairing QR",
        "setup.scanInstructions" to "Open the ByWave APP on your phone, sign in, then scan the QR shown here.",

        // Event reminders (desktop notifications)
        "reminder.untitled" to "Event",
        "reminder.body" to "Starts at {time}",
        "settings.reminders.title" to "Event reminders",
        "settings.reminders.desc" to "Pop a desktop notification before an event starts. Per-computer setting.",
        "settings.reminders.enable" to "Enable reminders",
        "settings.reminders.lead" to "Notify",
        "settings.reminders.atStart" to "At start time",
        "settings.reminders.leadMinutes" to "{n} min before",
    )

    private val zhCN: Map<String, String> = mapOf(
        "app.name" to "ByWave Calendar",

        "topbar.today" to "今天",
        "topbar.prevDay" to "前一天",
        "topbar.prevWeek" to "上一周",
        "topbar.prevMonth" to "上一月",
        "topbar.nextDay" to "后一天",
        "topbar.nextWeek" to "下一周",
        "topbar.nextMonth" to "下一月",
        "topbar.refresh" to "刷新",
        "topbar.new" to "新建",
        "topbar.search" to "搜索",
        "topbar.settings" to "设置",
        "viewmode.day" to "日",
        "viewmode.week" to "周",
        "viewmode.month" to "月",

        "menu.appGroup" to "ByWave Calendar",
        "menu.showWindow" to "显示窗口",
        "menu.settings" to "设置…",
        "menu.checkUpdate" to "检查更新…",
        "menu.quit" to "退出 ByWave Calendar",

        "settings.title" to "设置",
        "settings.close" to "关闭设置",
        "settings.tabAccount" to "账户",
        "settings.tabCalendars" to "日历",
        "settings.tabSecurity" to "安全",
        "settings.tabAppearance" to "外观",
        "settings.tabAbout" to "关于",

        "settings.account.title" to "账户",
        "settings.account.email" to "邮箱",
        "settings.account.displayName" to "显示名",
        "settings.account.server" to "服务器",
        "settings.account.deviceId" to "设备 ID",
        "settings.profileMgmt.title" to "账号管理",
        "settings.profileMgmt.desc" to "切换 / 添加 / 移除 ByWave 服务器。每个账号是独立的服务器+用户组合。",
        "settings.profileMgmt.switch" to "切换",
        "settings.profileMgmt.remove" to "移除",
        "settings.profileMgmt.addServer" to "+ 添加服务器",
        "settings.signOut.title" to "退出当前账号",
        "settings.signOut.desc" to "退出会保留本地缓存的事件数据。重新登录同一账号可以接着用。",
        "settings.signOut.button" to "退出当前账号",

        "settings.calendars.title" to "我的日历",
        "settings.calendars.desc" to "可直接在这里新建、重命名、改颜色 / 时区，或删除日历。",
        "settings.calendars.empty" to "还没有日历。",
        "settings.calendars.openOnWeb" to "在网页管理日历",
        // Settings — Calendars（管理）
        "settings.calendars.new" to "+ 新建日历",
        "settings.calendars.edit" to "编辑",
        "settings.calendars.delete" to "删除",
        "settings.calendars.share" to "分享链接",
        "settings.calendars.createTitle" to "新建日历",
        "settings.calendars.editTitle" to "编辑日历",
        "settings.calendars.nameLabel" to "名称",
        "settings.calendars.colorLabel" to "颜色",
        "settings.calendars.timezoneLabel" to "时区",
        "settings.calendars.descLabel" to "描述",
        "settings.calendars.create" to "创建",
        "settings.calendars.save" to "保存",
        "settings.calendars.cancel" to "取消",
        // 删除确认必须明确说明级联：删除日历会连同其所有事件一并删除。
        "settings.calendars.deleteTitle" to "删除日历？",
        "settings.calendars.deleteWarning" to "这将永久删除「{name}」及其所有事件，且无法撤销。",
        "settings.calendars.deleteConfirm" to "删除日历",

        // Settings — 日历 / 分享（订阅）链接
        "settings.share.title" to "分享「{name}」",
        "settings.share.intro" to "生成只读订阅链接（.ics）。任何人拿到链接即可在自己的日历 APP 中订阅。随时撤销链接即可断开访问。",
        "settings.share.labelPlaceholder" to "标签（可选）",
        "settings.share.generate" to "生成链接",
        "settings.share.generateFailed" to "生成链接失败。",
        "settings.share.loading" to "正在加载链接…",
        "settings.share.loadFailed" to "加载分享链接失败。",
        "settings.share.empty" to "还没有分享链接。",
        "settings.share.unnamed" to "（未命名）",
        "settings.share.copy" to "复制链接",
        "settings.share.copied" to "已复制",
        "settings.share.revoke" to "撤销",
        "settings.share.revokeTitle" to "撤销链接？",
        "settings.share.revokeConfirm" to "仍在订阅此链接的人将不再收到更新，且无法撤销。",
        "settings.share.revokeFailed" to "撤销链接失败。",
        "settings.share.close" to "完成",

        // 全局搜索弹窗
        "search.title" to "搜索事件",
        "search.placeholder" to "标题 / 描述 / 地点",
        "search.hint" to "输入关键词，在你的所有日历中搜索。",
        "search.searching" to "正在搜索…",
        "search.empty" to "没有匹配。",
        "search.failed" to "搜索失败。",
        "search.close" to "关闭",

        "settings.security.title" to "安全",
        "settings.security.desc" to "敏感操作（改密码 / Passkey / MFA / 删除账号）走网页 —— 桌面 APP 通过一次性令牌把你直接送进已登录的网页。",
        "settings.security.changePassword" to "修改密码",
        "settings.security.changePassword.sub" to "需要当前密码",
        "settings.security.passkey" to "Passkey 管理",
        "settings.security.passkey.sub" to "添加 / 重命名 / 撤销",
        "settings.security.mfa" to "二次验证 (TOTP)",
        "settings.security.mfa.sub" to "MFA / 备用码",
        "settings.security.devices" to "我的设备",
        "settings.security.devices.sub" to "查看 / 撤销其它登录",
        "settings.security.loginHistory" to "登录历史",
        "settings.security.loginHistory.sub" to "最近 100 条登录记录",
        "settings.security.danger" to "危险操作",
        "settings.security.deleteAccount" to "删除账号",
        "settings.security.deleteAccount.sub" to "永久删除，请谨慎",

        // 安全 / 原生修改密码弹窗
        "settings.security.changePassword.title" to "修改密码",
        "settings.security.changePassword.current" to "当前密码",
        "settings.security.changePassword.new" to "新密码",
        "settings.security.changePassword.confirm" to "确认新密码",
        "settings.security.changePassword.hint" to "新密码至少 8 个字符。",
        "settings.security.changePassword.submit" to "修改密码",
        "settings.security.changePassword.cancel" to "取消",
        "settings.security.changePassword.close" to "关闭",
        "settings.security.changePassword.mismatch" to "两次输入的新密码不一致。",
        "settings.security.changePassword.success" to "密码已修改。",
        "settings.security.changePassword.otherSessions" to "出于安全考虑，其它已登录的会话都已退出。当前设备仍保持登录。",
        "settings.security.changePassword.failed" to "修改密码失败。",

        // 安全 / 原生「我的设备」列表
        "settings.devices.title" to "我的设备",
        "settings.devices.desc" to "已与你账号配对的设备和 APP。不认识的请撤销。",
        "settings.devices.loading" to "正在加载设备…",
        "settings.devices.empty" to "暂无配对的设备。",
        "settings.devices.thisDevice" to "当前设备",
        "settings.devices.lastSeen" to "最近活动 {when}",
        "settings.devices.revoke" to "撤销",
        "settings.devices.revokeTitle" to "撤销该设备？",
        "settings.devices.revokeConfirm" to "确定要让「{label}」退出登录吗？它需要重新配对才能继续同步。",
        "settings.devices.revokeFailed" to "撤销设备失败。",
        "settings.devices.loadFailed" to "加载设备列表失败。",

        "settings.appearance.title" to "外观",
        "settings.appearance.desc" to "主题 / 配色 / 密度的偏好绑定到你的账号 —— 在网页设置一次，下次桌面端登录同步生效。",
        "settings.appearance.openOnWeb" to "在网页选择主题 / 密度",

        "settings.language.title" to "语言",
        "settings.language.desc" to "桌面端界面语言。在这台电脑上的所有账号都生效。",

        "settings.about.title" to "关于",
        "settings.about.app" to "应用",
        "settings.about.version" to "版本",
        "settings.about.server" to "服务器",
        "settings.about.license" to "许可证",
        "settings.about.copyright" to "版权",
        "settings.about.checkUpdate" to "检查更新",
        "settings.about.github" to "GitHub",
        "settings.about.tagline" to "ByWave Calendar 是一个开源的自托管日历共享平台。桌面端用 Compose Multiplatform 构建 —— Mac / Win / Linux 同一份 Kotlin 源码。",

        "openInWeb.openFailed" to "打开网页失败",
        "openInWeb.openFailed.title" to "打开失败",
        "openInWeb.ok" to "好的",
        "openInWeb.openInBrowser" to "在浏览器打开",

        "update.title" to "发现新版本",
        "update.installed" to "当前已安装",
        "update.latest" to "最新",
        "update.releaseNotes" to "更新内容",
        "update.downloadButton" to "下载并安装",
        "update.downloading" to "正在下载…",
        "update.openInFinder" to "在 Finder 中显示",
        "update.notNow" to "稍后再说",
        "update.upToDate.title" to "已是最新版本",
        "update.upToDate.body" to "当前已经是最新的 v{version}。",
        "update.upToDate.checking" to "正在检查更新…",
        "update.upToDate.button" to "好的",

        "sidebar.calendars" to "日历",
        "sidebar.empty" to "（暂无日历）",

        "error.retry" to "重试",

        "setup.title" to "连接到你的 ByWave 服务器",
        "setup.serverUrl" to "服务器地址",
        "setup.scanButton" to "显示配对二维码",
        "setup.scanInstructions" to "打开手机上的 ByWave APP，登录后扫描这里的二维码即可。",

        // 事件提醒（桌面通知）
        "reminder.untitled" to "事件",
        "reminder.body" to "{time} 开始",
        "settings.reminders.title" to "事件提醒",
        "settings.reminders.desc" to "事件开始前在桌面弹出通知提醒。此设置按电脑保存。",
        "settings.reminders.enable" to "开启提醒",
        "settings.reminders.lead" to "提前",
        "settings.reminders.atStart" to "事件开始时",
        "settings.reminders.leadMinutes" to "提前 {n} 分钟",
    )

    private val zhTW: Map<String, String> = mapOf(
        "app.name" to "ByWave Calendar",

        "topbar.today" to "今天",
        "topbar.prevDay" to "前一天",
        "topbar.prevWeek" to "上一週",
        "topbar.prevMonth" to "上一月",
        "topbar.nextDay" to "後一天",
        "topbar.nextWeek" to "下一週",
        "topbar.nextMonth" to "下一月",
        "topbar.refresh" to "重新整理",
        "topbar.new" to "新增",
        "topbar.settings" to "設定",
        "viewmode.day" to "日",
        "viewmode.week" to "週",
        "viewmode.month" to "月",

        "menu.appGroup" to "ByWave Calendar",
        "menu.showWindow" to "顯示視窗",
        "menu.settings" to "設定…",
        "menu.checkUpdate" to "檢查更新…",
        "menu.quit" to "結束 ByWave Calendar",

        "settings.title" to "設定",
        "settings.close" to "關閉設定",
        "settings.tabAccount" to "帳戶",
        "settings.tabCalendars" to "行事曆",
        "settings.tabSecurity" to "安全性",
        "settings.tabAppearance" to "外觀",
        "settings.tabAbout" to "關於",

        "settings.account.title" to "帳戶",
        "settings.account.email" to "電子郵件",
        "settings.account.displayName" to "顯示名稱",
        "settings.account.server" to "伺服器",
        "settings.account.deviceId" to "裝置 ID",
        "settings.profileMgmt.title" to "帳號管理",
        "settings.profileMgmt.desc" to "切換 / 新增 / 移除 ByWave 伺服器。每個帳號都是獨立的伺服器+使用者組合。",
        "settings.profileMgmt.switch" to "切換",
        "settings.profileMgmt.remove" to "移除",
        "settings.profileMgmt.addServer" to "+ 新增伺服器",
        "settings.signOut.title" to "登出目前帳號",
        "settings.signOut.desc" to "登出會保留本機快取的事件資料。以同一帳號重新登入即可接續使用。",
        "settings.signOut.button" to "登出目前帳號",

        "settings.calendars.title" to "我的行事曆",
        "settings.calendars.desc" to "桌面端目前僅供唯讀顯示。新增 / 刪除 / 修改屬性請至網頁端。",
        "settings.calendars.empty" to "還沒有行事曆。",
        "settings.calendars.openOnWeb" to "在網頁管理行事曆",

        "settings.security.title" to "安全性",
        "settings.security.desc" to "敏感操作（變更密碼 / Passkey / MFA / 刪除帳號）走網頁 —— 桌面 APP 透過一次性權杖將你直接送進已登入的網頁。",
        "settings.security.changePassword" to "變更密碼",
        "settings.security.changePassword.sub" to "需要目前的密碼",
        "settings.security.passkey" to "Passkey 管理",
        "settings.security.passkey.sub" to "新增 / 重新命名 / 撤銷",
        "settings.security.mfa" to "兩步驟驗證 (TOTP)",
        "settings.security.mfa.sub" to "MFA / 備用碼",
        "settings.security.devices" to "我的裝置",
        "settings.security.devices.sub" to "檢視 / 撤銷其他登入",
        "settings.security.loginHistory" to "登入紀錄",
        "settings.security.loginHistory.sub" to "最近 100 筆登入紀錄",
        "settings.security.danger" to "危險操作",
        "settings.security.deleteAccount" to "刪除帳號",
        "settings.security.deleteAccount.sub" to "永久刪除，請謹慎",

        "settings.appearance.title" to "外觀",
        "settings.appearance.desc" to "主題 / 配色 / 密度的偏好設定綁定到你的帳號 —— 在網頁設定一次，下次桌面端登入即同步生效。",
        "settings.appearance.openOnWeb" to "在網頁選擇主題 / 密度",

        "settings.language.title" to "語言",
        "settings.language.desc" to "桌面端介面語言。在這台電腦上的所有帳號都會生效。",

        "settings.about.title" to "關於",
        "settings.about.app" to "應用程式",
        "settings.about.version" to "版本",
        "settings.about.server" to "伺服器",
        "settings.about.license" to "授權條款",
        "settings.about.copyright" to "版權",
        "settings.about.checkUpdate" to "檢查更新",
        "settings.about.github" to "GitHub",
        "settings.about.tagline" to "ByWave Calendar 是一個開源的自架行事曆共享平台。桌面端以 Compose Multiplatform 建構 —— Mac / Win / Linux 共用同一份 Kotlin 原始碼。",

        "openInWeb.openFailed" to "開啟網頁失敗",
        "openInWeb.openFailed.title" to "開啟失敗",
        "openInWeb.ok" to "好的",
        "openInWeb.openInBrowser" to "在瀏覽器開啟",

        "update.title" to "發現新版本",
        "update.installed" to "目前已安裝",
        "update.latest" to "最新",
        "update.releaseNotes" to "更新內容",
        "update.downloadButton" to "下載並安裝",
        "update.downloading" to "正在下載…",
        "update.openInFinder" to "在 Finder 中顯示",
        "update.notNow" to "稍後再說",
        "update.upToDate.title" to "已是最新版本",
        "update.upToDate.body" to "目前已經是最新的 v{version}。",
        "update.upToDate.checking" to "正在檢查更新…",
        "update.upToDate.button" to "好的",

        "sidebar.calendars" to "行事曆",
        "sidebar.empty" to "（暫無行事曆）",

        "error.retry" to "重試",

        "setup.title" to "連線到你的 ByWave 伺服器",
        "setup.serverUrl" to "伺服器位址",
        "setup.scanButton" to "顯示配對 QR 碼",
        "setup.scanInstructions" to "開啟手機上的 ByWave APP，登入後掃描這裡的 QR 碼即可。",
    )

    private val ja: Map<String, String> = mapOf(
        "app.name" to "ByWave Calendar",

        "topbar.today" to "今日",
        "topbar.prevDay" to "前日",
        "topbar.prevWeek" to "前週",
        "topbar.prevMonth" to "前月",
        "topbar.nextDay" to "翌日",
        "topbar.nextWeek" to "翌週",
        "topbar.nextMonth" to "翌月",
        "topbar.refresh" to "更新",
        "topbar.new" to "新規イベント",
        "topbar.settings" to "設定",
        "viewmode.day" to "日",
        "viewmode.week" to "週",
        "viewmode.month" to "月",

        "menu.appGroup" to "ByWave Calendar",
        "menu.showWindow" to "ウインドウを表示",
        "menu.settings" to "設定…",
        "menu.checkUpdate" to "アップデートを確認…",
        "menu.quit" to "ByWave Calendar を終了",

        "settings.title" to "設定",
        "settings.close" to "設定を閉じる",
        "settings.tabAccount" to "アカウント",
        "settings.tabCalendars" to "カレンダー",
        "settings.tabSecurity" to "セキュリティ",
        "settings.tabAppearance" to "外観",
        "settings.tabAbout" to "情報",

        "settings.account.title" to "アカウント",
        "settings.account.email" to "メール",
        "settings.account.displayName" to "表示名",
        "settings.account.server" to "サーバー",
        "settings.account.deviceId" to "デバイス ID",
        "settings.profileMgmt.title" to "アカウントの管理",
        "settings.profileMgmt.desc" to "ByWave サーバーの切り替え / 追加 / 削除。各プロファイルは独立したサーバーとユーザーの組み合わせです。",
        "settings.profileMgmt.switch" to "切り替え",
        "settings.profileMgmt.remove" to "削除",
        "settings.profileMgmt.addServer" to "+ サーバーを追加",
        "settings.signOut.title" to "現在のアカウントからサインアウト",
        "settings.signOut.desc" to "サインアウトしてもキャッシュされたイベントデータはローカルに保持されます。同じアカウントで再度サインインすれば続きから利用できます。",
        "settings.signOut.button" to "現在のアカウントからサインアウト",

        "settings.calendars.title" to "マイカレンダー",
        "settings.calendars.desc" to "デスクトップは現在読み取り専用です。カレンダーの作成 / 削除 / 編集はウェブで行ってください。",
        "settings.calendars.empty" to "カレンダーがまだありません。",
        "settings.calendars.openOnWeb" to "ウェブでカレンダーを管理",

        "settings.security.title" to "セキュリティ",
        "settings.security.desc" to "機密性の高い操作（パスワード変更 / Passkey / MFA / アカウント削除）はウェブで行います。デスクトップはワンタイムトークンを渡すので、パスワードを再入力する必要はありません。",
        "settings.security.changePassword" to "パスワードを変更",
        "settings.security.changePassword.sub" to "現在のパスワードが必要です",
        "settings.security.passkey" to "Passkey",
        "settings.security.passkey.sub" to "追加 / 名前変更 / 取り消し",
        "settings.security.mfa" to "二要素認証 (TOTP)",
        "settings.security.mfa.sub" to "MFA / バックアップコード",
        "settings.security.devices" to "マイデバイス",
        "settings.security.devices.sub" to "他のセッションを表示 / 取り消し",
        "settings.security.loginHistory" to "ログイン履歴",
        "settings.security.loginHistory.sub" to "直近 100 件のサインイン",
        "settings.security.danger" to "危険な操作",
        "settings.security.deleteAccount" to "アカウントを削除",
        "settings.security.deleteAccount.sub" to "永久に削除されます。慎重に操作してください",

        "settings.appearance.title" to "外観",
        "settings.appearance.desc" to "テーマ / カラーパレット / 密度はアカウントごとに保存されます。ウェブで一度選択すれば、次回デスクトップでサインインした際に同期されます。",
        "settings.appearance.openOnWeb" to "ウェブでテーマを選択",

        "settings.language.title" to "言語",
        "settings.language.desc" to "デスクトップ UI の言語。このコンピューター上のすべてのプロファイルに適用されます。",

        "settings.about.title" to "情報",
        "settings.about.app" to "アプリケーション",
        "settings.about.version" to "バージョン",
        "settings.about.server" to "サーバー",
        "settings.about.license" to "ライセンス",
        "settings.about.copyright" to "著作権",
        "settings.about.checkUpdate" to "アップデートを確認",
        "settings.about.github" to "GitHub",
        "settings.about.tagline" to "ByWave Calendar はセルフホスト型のカレンダー共有プラットフォームです。デスクトップクライアントは Compose Multiplatform で構築され、単一の Kotlin コードベースから Mac / Windows / Linux 向けに提供されます。",

        "openInWeb.openFailed" to "ブラウザーを開けませんでした",
        "openInWeb.openFailed.title" to "開けませんでした",
        "openInWeb.ok" to "OK",
        "openInWeb.openInBrowser" to "ブラウザーで開く",

        "update.title" to "新しいバージョンが利用可能です",
        "update.installed" to "現在インストール済み",
        "update.latest" to "最新",
        "update.releaseNotes" to "新着情報",
        "update.downloadButton" to "ダウンロードしてインストール",
        "update.downloading" to "ダウンロード中…",
        "update.openInFinder" to "Finder で表示",
        "update.notNow" to "後で",
        "update.upToDate.title" to "最新の状態です",
        "update.upToDate.body" to "すでに最新バージョン (v{version}) を使用しています。",
        "update.upToDate.checking" to "アップデートを確認中…",
        "update.upToDate.button" to "OK",

        "sidebar.calendars" to "カレンダー",
        "sidebar.empty" to "（カレンダーなし）",

        "error.retry" to "再試行",

        "setup.title" to "ByWave サーバーに接続",
        "setup.serverUrl" to "サーバー URL",
        "setup.scanButton" to "ペアリング QR を表示",
        "setup.scanInstructions" to "スマートフォンで ByWave APP を開いてサインインし、ここに表示される QR をスキャンしてください。",
    )

    private val ko: Map<String, String> = mapOf(
        "app.name" to "ByWave Calendar",

        "topbar.today" to "오늘",
        "topbar.prevDay" to "이전 날",
        "topbar.prevWeek" to "이전 주",
        "topbar.prevMonth" to "이전 달",
        "topbar.nextDay" to "다음 날",
        "topbar.nextWeek" to "다음 주",
        "topbar.nextMonth" to "다음 달",
        "topbar.refresh" to "새로고침",
        "topbar.new" to "새 일정",
        "topbar.settings" to "설정",
        "viewmode.day" to "일",
        "viewmode.week" to "주",
        "viewmode.month" to "월",

        "menu.appGroup" to "ByWave Calendar",
        "menu.showWindow" to "창 표시",
        "menu.settings" to "설정…",
        "menu.checkUpdate" to "업데이트 확인…",
        "menu.quit" to "ByWave Calendar 종료",

        "settings.title" to "설정",
        "settings.close" to "설정 닫기",
        "settings.tabAccount" to "계정",
        "settings.tabCalendars" to "캘린더",
        "settings.tabSecurity" to "보안",
        "settings.tabAppearance" to "모양",
        "settings.tabAbout" to "정보",

        "settings.account.title" to "계정",
        "settings.account.email" to "이메일",
        "settings.account.displayName" to "표시 이름",
        "settings.account.server" to "서버",
        "settings.account.deviceId" to "기기 ID",
        "settings.profileMgmt.title" to "계정 관리",
        "settings.profileMgmt.desc" to "ByWave 서버 전환 / 추가 / 제거. 각 프로필은 서버와 사용자의 독립적인 조합입니다.",
        "settings.profileMgmt.switch" to "전환",
        "settings.profileMgmt.remove" to "제거",
        "settings.profileMgmt.addServer" to "+ 서버 추가",
        "settings.signOut.title" to "현재 계정에서 로그아웃",
        "settings.signOut.desc" to "로그아웃해도 캐시된 일정 데이터는 로컬에 유지됩니다. 같은 계정으로 다시 로그인하면 이어서 사용할 수 있습니다.",
        "settings.signOut.button" to "현재 계정에서 로그아웃",

        "settings.calendars.title" to "내 캘린더",
        "settings.calendars.desc" to "데스크톱은 현재 읽기 전용입니다. 캘린더 생성 / 삭제 / 편집은 웹에서 하세요.",
        "settings.calendars.empty" to "아직 캘린더가 없습니다.",
        "settings.calendars.openOnWeb" to "웹에서 캘린더 관리",

        "settings.security.title" to "보안",
        "settings.security.desc" to "민감한 작업(비밀번호 변경 / Passkey / MFA / 계정 삭제)은 웹에서 열립니다. 데스크톱이 일회용 토큰을 전달하므로 비밀번호를 다시 입력할 필요가 없습니다.",
        "settings.security.changePassword" to "비밀번호 변경",
        "settings.security.changePassword.sub" to "현재 비밀번호 필요",
        "settings.security.passkey" to "Passkey",
        "settings.security.passkey.sub" to "추가 / 이름 변경 / 취소",
        "settings.security.mfa" to "2단계 인증 (TOTP)",
        "settings.security.mfa.sub" to "MFA / 백업 코드",
        "settings.security.devices" to "내 기기",
        "settings.security.devices.sub" to "다른 세션 보기 / 취소",
        "settings.security.loginHistory" to "로그인 기록",
        "settings.security.loginHistory.sub" to "최근 100건의 로그인",
        "settings.security.danger" to "위험 구역",
        "settings.security.deleteAccount" to "계정 삭제",
        "settings.security.deleteAccount.sub" to "영구적입니다. 신중하게 진행하세요",

        "settings.appearance.title" to "모양",
        "settings.appearance.desc" to "테마 / 색상 / 밀도는 계정별로 저장됩니다. 웹에서 한 번 선택하면 다음에 데스크톱에 로그인할 때 동기화됩니다.",
        "settings.appearance.openOnWeb" to "웹에서 테마 선택",

        "settings.language.title" to "언어",
        "settings.language.desc" to "데스크톱 UI 언어. 이 컴퓨터의 모든 프로필에 적용됩니다.",

        "settings.about.title" to "정보",
        "settings.about.app" to "애플리케이션",
        "settings.about.version" to "버전",
        "settings.about.server" to "서버",
        "settings.about.license" to "라이선스",
        "settings.about.copyright" to "저작권",
        "settings.about.checkUpdate" to "업데이트 확인",
        "settings.about.github" to "GitHub",
        "settings.about.tagline" to "ByWave Calendar는 셀프 호스팅 캘린더 공유 플랫폼입니다. 데스크톱 클라이언트는 Compose Multiplatform으로 제작되어 하나의 Kotlin 코드베이스로 Mac / Windows / Linux에 배포됩니다.",

        "openInWeb.openFailed" to "브라우저를 열지 못했습니다",
        "openInWeb.openFailed.title" to "열 수 없음",
        "openInWeb.ok" to "확인",
        "openInWeb.openInBrowser" to "브라우저에서 열기",

        "update.title" to "새 버전 사용 가능",
        "update.installed" to "현재 설치됨",
        "update.latest" to "최신",
        "update.releaseNotes" to "새로운 기능",
        "update.downloadButton" to "다운로드 및 설치",
        "update.downloading" to "다운로드 중…",
        "update.openInFinder" to "Finder에서 열기",
        "update.notNow" to "나중에",
        "update.upToDate.title" to "최신 상태입니다",
        "update.upToDate.body" to "이미 최신 버전(v{version})을 사용 중입니다.",
        "update.upToDate.checking" to "업데이트 확인 중…",
        "update.upToDate.button" to "확인",

        "sidebar.calendars" to "캘린더",
        "sidebar.empty" to "(캘린더 없음)",

        "error.retry" to "다시 시도",

        "setup.title" to "ByWave 서버에 연결",
        "setup.serverUrl" to "서버 URL",
        "setup.scanButton" to "페어링 QR 표시",
        "setup.scanInstructions" to "휴대폰에서 ByWave APP을 열고 로그인한 다음 여기에 표시된 QR을 스캔하세요.",
    )

    private val es: Map<String, String> = mapOf(
        "app.name" to "ByWave Calendar",

        "topbar.today" to "Hoy",
        "topbar.prevDay" to "Día anterior",
        "topbar.prevWeek" to "Semana anterior",
        "topbar.prevMonth" to "Mes anterior",
        "topbar.nextDay" to "Día siguiente",
        "topbar.nextWeek" to "Semana siguiente",
        "topbar.nextMonth" to "Mes siguiente",
        "topbar.refresh" to "Actualizar",
        "topbar.new" to "Nuevo evento",
        "topbar.settings" to "Ajustes",
        "viewmode.day" to "Día",
        "viewmode.week" to "Semana",
        "viewmode.month" to "Mes",

        "menu.appGroup" to "ByWave Calendar",
        "menu.showWindow" to "Mostrar ventana",
        "menu.settings" to "Ajustes…",
        "menu.checkUpdate" to "Buscar actualizaciones…",
        "menu.quit" to "Salir de ByWave Calendar",

        "settings.title" to "Ajustes",
        "settings.close" to "Cerrar ajustes",
        "settings.tabAccount" to "Cuenta",
        "settings.tabCalendars" to "Calendarios",
        "settings.tabSecurity" to "Seguridad",
        "settings.tabAppearance" to "Apariencia",
        "settings.tabAbout" to "Acerca de",

        "settings.account.title" to "Cuenta",
        "settings.account.email" to "Correo electrónico",
        "settings.account.displayName" to "Nombre visible",
        "settings.account.server" to "Servidor",
        "settings.account.deviceId" to "ID de dispositivo",
        "settings.profileMgmt.title" to "Gestionar cuentas",
        "settings.profileMgmt.desc" to "Cambia / añade / elimina servidores ByWave. Cada perfil es su propia combinación de servidor y usuario.",
        "settings.profileMgmt.switch" to "Cambiar",
        "settings.profileMgmt.remove" to "Eliminar",
        "settings.profileMgmt.addServer" to "+ Añadir servidor",
        "settings.signOut.title" to "Cerrar sesión de la cuenta actual",
        "settings.signOut.desc" to "Al cerrar sesión se conservan localmente los datos de eventos en caché. Al volver a iniciar sesión con la misma cuenta, retomas donde lo dejaste.",
        "settings.signOut.button" to "Cerrar sesión de la cuenta actual",

        "settings.calendars.title" to "Mis calendarios",
        "settings.calendars.desc" to "El escritorio es de solo lectura por ahora. Crea / elimina / edita calendarios en la web.",
        "settings.calendars.empty" to "Aún no hay calendarios.",
        "settings.calendars.openOnWeb" to "Gestionar calendarios en la web",

        "settings.security.title" to "Seguridad",
        "settings.security.desc" to "Las acciones sensibles (cambiar contraseña / Passkey / MFA / eliminar cuenta) se abren en la web: el escritorio te entrega un token de un solo uso para que no tengas que volver a escribir tu contraseña.",
        "settings.security.changePassword" to "Cambiar contraseña",
        "settings.security.changePassword.sub" to "Requiere la contraseña actual",
        "settings.security.passkey" to "Passkey",
        "settings.security.passkey.sub" to "Añadir / renombrar / revocar",
        "settings.security.mfa" to "Doble factor (TOTP)",
        "settings.security.mfa.sub" to "MFA / códigos de respaldo",
        "settings.security.devices" to "Mis dispositivos",
        "settings.security.devices.sub" to "Ver / revocar otras sesiones",
        "settings.security.loginHistory" to "Historial de inicios de sesión",
        "settings.security.loginHistory.sub" to "Últimos 100 inicios de sesión",
        "settings.security.danger" to "Zona de peligro",
        "settings.security.deleteAccount" to "Eliminar cuenta",
        "settings.security.deleteAccount.sub" to "Permanente: procede con cuidado",

        "settings.appearance.title" to "Apariencia",
        "settings.appearance.desc" to "El tema / la paleta / la densidad se guardan por cuenta. Elígelos una vez en la web y se sincronizan la próxima vez que el escritorio inicie sesión.",
        "settings.appearance.openOnWeb" to "Elegir tema en la web",

        "settings.language.title" to "Idioma",
        "settings.language.desc" to "Idioma de la interfaz de escritorio. Se aplica a todos los perfiles de este equipo.",

        "settings.about.title" to "Acerca de",
        "settings.about.app" to "Aplicación",
        "settings.about.version" to "Versión",
        "settings.about.server" to "Servidor",
        "settings.about.license" to "Licencia",
        "settings.about.copyright" to "Derechos de autor",
        "settings.about.checkUpdate" to "Buscar actualizaciones",
        "settings.about.github" to "GitHub",
        "settings.about.tagline" to "ByWave Calendar es una plataforma autoalojada para compartir calendarios. El cliente de escritorio está creado con Compose Multiplatform: una sola base de código Kotlin se distribuye a Mac / Windows / Linux.",

        "openInWeb.openFailed" to "No se pudo abrir el navegador",
        "openInWeb.openFailed.title" to "No se pudo abrir",
        "openInWeb.ok" to "Aceptar",
        "openInWeb.openInBrowser" to "Abrir en el navegador",

        "update.title" to "Nueva versión disponible",
        "update.installed" to "Instalada actualmente",
        "update.latest" to "Última",
        "update.releaseNotes" to "Novedades",
        "update.downloadButton" to "Descargar e instalar",
        "update.downloading" to "Descargando…",
        "update.openInFinder" to "Abrir en Finder",
        "update.notNow" to "Ahora no",
        "update.upToDate.title" to "Estás al día",
        "update.upToDate.body" to "Ya estás usando la última versión (v{version}).",
        "update.upToDate.checking" to "Buscando actualizaciones…",
        "update.upToDate.button" to "Aceptar",

        "sidebar.calendars" to "Calendarios",
        "sidebar.empty" to "(sin calendarios)",

        "error.retry" to "Reintentar",

        "setup.title" to "Conéctate a tu servidor ByWave",
        "setup.serverUrl" to "URL del servidor",
        "setup.scanButton" to "Mostrar QR de emparejamiento",
        "setup.scanInstructions" to "Abre la ByWave APP en tu teléfono, inicia sesión y escanea el QR que se muestra aquí.",
    )

    private val fr: Map<String, String> = mapOf(
        "app.name" to "ByWave Calendar",

        "topbar.today" to "Aujourd'hui",
        "topbar.prevDay" to "Jour précédent",
        "topbar.prevWeek" to "Semaine précédente",
        "topbar.prevMonth" to "Mois précédent",
        "topbar.nextDay" to "Jour suivant",
        "topbar.nextWeek" to "Semaine suivante",
        "topbar.nextMonth" to "Mois suivant",
        "topbar.refresh" to "Actualiser",
        "topbar.new" to "Nouvel événement",
        "topbar.settings" to "Réglages",
        "viewmode.day" to "Jour",
        "viewmode.week" to "Semaine",
        "viewmode.month" to "Mois",

        "menu.appGroup" to "ByWave Calendar",
        "menu.showWindow" to "Afficher la fenêtre",
        "menu.settings" to "Réglages…",
        "menu.checkUpdate" to "Rechercher des mises à jour…",
        "menu.quit" to "Quitter ByWave Calendar",

        "settings.title" to "Réglages",
        "settings.close" to "Fermer les réglages",
        "settings.tabAccount" to "Compte",
        "settings.tabCalendars" to "Calendriers",
        "settings.tabSecurity" to "Sécurité",
        "settings.tabAppearance" to "Apparence",
        "settings.tabAbout" to "À propos",

        "settings.account.title" to "Compte",
        "settings.account.email" to "E-mail",
        "settings.account.displayName" to "Nom affiché",
        "settings.account.server" to "Serveur",
        "settings.account.deviceId" to "ID de l'appareil",
        "settings.profileMgmt.title" to "Gérer les comptes",
        "settings.profileMgmt.desc" to "Changez / ajoutez / supprimez des serveurs ByWave. Chaque profil est sa propre combinaison serveur + utilisateur.",
        "settings.profileMgmt.switch" to "Changer",
        "settings.profileMgmt.remove" to "Supprimer",
        "settings.profileMgmt.addServer" to "+ Ajouter un serveur",
        "settings.signOut.title" to "Se déconnecter du compte actuel",
        "settings.signOut.desc" to "La déconnexion conserve localement les données d'événements mises en cache. En vous reconnectant avec le même compte, vous reprenez là où vous en étiez.",
        "settings.signOut.button" to "Se déconnecter du compte actuel",

        "settings.calendars.title" to "Mes calendriers",
        "settings.calendars.desc" to "Le bureau est en lecture seule pour l'instant. Créez / supprimez / modifiez les calendriers sur le web.",
        "settings.calendars.empty" to "Aucun calendrier pour le moment.",
        "settings.calendars.openOnWeb" to "Gérer les calendriers sur le web",

        "settings.security.title" to "Sécurité",
        "settings.security.desc" to "Les actions sensibles (changer le mot de passe / Passkey / MFA / supprimer le compte) s'ouvrent sur le web : le bureau vous remet un jeton à usage unique pour que vous n'ayez pas à ressaisir votre mot de passe.",
        "settings.security.changePassword" to "Changer le mot de passe",
        "settings.security.changePassword.sub" to "Nécessite le mot de passe actuel",
        "settings.security.passkey" to "Passkey",
        "settings.security.passkey.sub" to "Ajouter / renommer / révoquer",
        "settings.security.mfa" to "Double authentification (TOTP)",
        "settings.security.mfa.sub" to "MFA / codes de secours",
        "settings.security.devices" to "Mes appareils",
        "settings.security.devices.sub" to "Voir / révoquer les autres sessions",
        "settings.security.loginHistory" to "Historique de connexion",
        "settings.security.loginHistory.sub" to "100 dernières connexions",
        "settings.security.danger" to "Zone de danger",
        "settings.security.deleteAccount" to "Supprimer le compte",
        "settings.security.deleteAccount.sub" to "Définitif — procédez avec prudence",

        "settings.appearance.title" to "Apparence",
        "settings.appearance.desc" to "Le thème / la palette / la densité sont enregistrés par compte. Choisissez-les une fois sur le web et ils se synchronisent à la prochaine connexion du bureau.",
        "settings.appearance.openOnWeb" to "Choisir le thème sur le web",

        "settings.language.title" to "Langue",
        "settings.language.desc" to "Langue de l'interface du bureau. S'applique à tous les profils de cet ordinateur.",

        "settings.about.title" to "À propos",
        "settings.about.app" to "Application",
        "settings.about.version" to "Version",
        "settings.about.server" to "Serveur",
        "settings.about.license" to "Licence",
        "settings.about.copyright" to "Droits d'auteur",
        "settings.about.checkUpdate" to "Rechercher des mises à jour",
        "settings.about.github" to "GitHub",
        "settings.about.tagline" to "ByWave Calendar est une plateforme de partage de calendriers auto-hébergée. Le client de bureau est conçu avec Compose Multiplatform — une seule base de code Kotlin est livrée pour Mac / Windows / Linux.",

        "openInWeb.openFailed" to "Impossible d'ouvrir le navigateur",
        "openInWeb.openFailed.title" to "Ouverture impossible",
        "openInWeb.ok" to "OK",
        "openInWeb.openInBrowser" to "Ouvrir dans le navigateur",

        "update.title" to "Nouvelle version disponible",
        "update.installed" to "Actuellement installée",
        "update.latest" to "Dernière",
        "update.releaseNotes" to "Nouveautés",
        "update.downloadButton" to "Télécharger et installer",
        "update.downloading" to "Téléchargement…",
        "update.openInFinder" to "Ouvrir dans le Finder",
        "update.notNow" to "Pas maintenant",
        "update.upToDate.title" to "Vous êtes à jour",
        "update.upToDate.body" to "Vous utilisez déjà la dernière version (v{version}).",
        "update.upToDate.checking" to "Recherche de mises à jour…",
        "update.upToDate.button" to "OK",

        "sidebar.calendars" to "Calendriers",
        "sidebar.empty" to "(aucun calendrier)",

        "error.retry" to "Réessayer",

        "setup.title" to "Connectez-vous à votre serveur ByWave",
        "setup.serverUrl" to "URL du serveur",
        "setup.scanButton" to "Afficher le QR d'appairage",
        "setup.scanInstructions" to "Ouvrez la ByWave APP sur votre téléphone, connectez-vous, puis scannez le QR affiché ici.",
    )

    private val de: Map<String, String> = mapOf(
        "app.name" to "ByWave Calendar",

        "topbar.today" to "Heute",
        "topbar.prevDay" to "Vorheriger Tag",
        "topbar.prevWeek" to "Vorherige Woche",
        "topbar.prevMonth" to "Vorheriger Monat",
        "topbar.nextDay" to "Nächster Tag",
        "topbar.nextWeek" to "Nächste Woche",
        "topbar.nextMonth" to "Nächster Monat",
        "topbar.refresh" to "Aktualisieren",
        "topbar.new" to "Neuer Termin",
        "topbar.settings" to "Einstellungen",
        "viewmode.day" to "Tag",
        "viewmode.week" to "Woche",
        "viewmode.month" to "Monat",

        "menu.appGroup" to "ByWave Calendar",
        "menu.showWindow" to "Fenster anzeigen",
        "menu.settings" to "Einstellungen…",
        "menu.checkUpdate" to "Nach Updates suchen…",
        "menu.quit" to "ByWave Calendar beenden",

        "settings.title" to "Einstellungen",
        "settings.close" to "Einstellungen schließen",
        "settings.tabAccount" to "Konto",
        "settings.tabCalendars" to "Kalender",
        "settings.tabSecurity" to "Sicherheit",
        "settings.tabAppearance" to "Darstellung",
        "settings.tabAbout" to "Über",

        "settings.account.title" to "Konto",
        "settings.account.email" to "E-Mail",
        "settings.account.displayName" to "Anzeigename",
        "settings.account.server" to "Server",
        "settings.account.deviceId" to "Geräte-ID",
        "settings.profileMgmt.title" to "Konten verwalten",
        "settings.profileMgmt.desc" to "ByWave-Server wechseln / hinzufügen / entfernen. Jedes Profil ist eine eigene Kombination aus Server und Benutzer.",
        "settings.profileMgmt.switch" to "Wechseln",
        "settings.profileMgmt.remove" to "Entfernen",
        "settings.profileMgmt.addServer" to "+ Server hinzufügen",
        "settings.signOut.title" to "Vom aktuellen Konto abmelden",
        "settings.signOut.desc" to "Beim Abmelden bleiben zwischengespeicherte Termindaten lokal erhalten. Wenn du dich mit demselben Konto erneut anmeldest, machst du dort weiter, wo du aufgehört hast.",
        "settings.signOut.button" to "Vom aktuellen Konto abmelden",

        "settings.calendars.title" to "Meine Kalender",
        "settings.calendars.desc" to "Der Desktop ist derzeit schreibgeschützt. Kalender erstellen / löschen / bearbeiten im Web.",
        "settings.calendars.empty" to "Noch keine Kalender.",
        "settings.calendars.openOnWeb" to "Kalender im Web verwalten",

        "settings.security.title" to "Sicherheit",
        "settings.security.desc" to "Sensible Aktionen (Passwort ändern / Passkey / MFA / Konto löschen) werden im Web geöffnet — der Desktop übergibt dir ein Einmal-Token, damit du dein Passwort nicht erneut eingeben musst.",
        "settings.security.changePassword" to "Passwort ändern",
        "settings.security.changePassword.sub" to "Erfordert das aktuelle Passwort",
        "settings.security.passkey" to "Passkey",
        "settings.security.passkey.sub" to "Hinzufügen / umbenennen / widerrufen",
        "settings.security.mfa" to "Zwei-Faktor (TOTP)",
        "settings.security.mfa.sub" to "MFA / Backup-Codes",
        "settings.security.devices" to "Meine Geräte",
        "settings.security.devices.sub" to "Andere Sitzungen anzeigen / widerrufen",
        "settings.security.loginHistory" to "Anmeldeverlauf",
        "settings.security.loginHistory.sub" to "Letzte 100 Anmeldungen",
        "settings.security.danger" to "Gefahrenzone",
        "settings.security.deleteAccount" to "Konto löschen",
        "settings.security.deleteAccount.sub" to "Dauerhaft — bitte vorsichtig vorgehen",

        "settings.appearance.title" to "Darstellung",
        "settings.appearance.desc" to "Thema / Farbpalette / Dichte werden pro Konto gespeichert. Einmal im Web auswählen, und sie werden bei der nächsten Desktop-Anmeldung synchronisiert.",
        "settings.appearance.openOnWeb" to "Thema im Web auswählen",

        "settings.language.title" to "Sprache",
        "settings.language.desc" to "Sprache der Desktop-Oberfläche. Gilt für alle Profile auf diesem Computer.",

        "settings.about.title" to "Über",
        "settings.about.app" to "Anwendung",
        "settings.about.version" to "Version",
        "settings.about.server" to "Server",
        "settings.about.license" to "Lizenz",
        "settings.about.copyright" to "Copyright",
        "settings.about.checkUpdate" to "Nach Updates suchen",
        "settings.about.github" to "GitHub",
        "settings.about.tagline" to "ByWave Calendar ist eine selbst gehostete Plattform zum Teilen von Kalendern. Der Desktop-Client wird mit Compose Multiplatform erstellt — eine einzige Kotlin-Codebasis wird für Mac / Windows / Linux ausgeliefert.",

        "openInWeb.openFailed" to "Browser konnte nicht geöffnet werden",
        "openInWeb.openFailed.title" to "Öffnen fehlgeschlagen",
        "openInWeb.ok" to "OK",
        "openInWeb.openInBrowser" to "Im Browser öffnen",

        "update.title" to "Neue Version verfügbar",
        "update.installed" to "Derzeit installiert",
        "update.latest" to "Neueste",
        "update.releaseNotes" to "Neuerungen",
        "update.downloadButton" to "Herunterladen und installieren",
        "update.downloading" to "Wird heruntergeladen…",
        "update.openInFinder" to "Im Finder öffnen",
        "update.notNow" to "Nicht jetzt",
        "update.upToDate.title" to "Du bist auf dem neuesten Stand",
        "update.upToDate.body" to "Du verwendest bereits die neueste Version (v{version}).",
        "update.upToDate.checking" to "Suche nach Updates…",
        "update.upToDate.button" to "OK",

        "sidebar.calendars" to "Kalender",
        "sidebar.empty" to "(keine Kalender)",

        "error.retry" to "Wiederholen",

        "setup.title" to "Mit deinem ByWave-Server verbinden",
        "setup.serverUrl" to "Server-URL",
        "setup.scanButton" to "Kopplungs-QR anzeigen",
        "setup.scanInstructions" to "Öffne die ByWave APP auf deinem Telefon, melde dich an und scanne dann den hier angezeigten QR.",
    )

    private val DICTIONARIES: Map<Locale, Map<String, String>> = mapOf(
        Locale.EN to en,
        Locale.ZH_CN to zhCN,
        Locale.ZH_TW to zhTW,
        Locale.JA to ja,
        Locale.KO to ko,
        Locale.ES to es,
        Locale.FR to fr,
        Locale.DE to de,
    )
}
