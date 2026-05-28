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
        EN("en", "English"),
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
        "settings.calendars.desc" to "Desktop is read-only for now. Create / delete / edit calendars on the web.",
        "settings.calendars.empty" to "No calendars yet.",
        "settings.calendars.openOnWeb" to "Manage calendars on the web",

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
        "settings.calendars.desc" to "桌面端目前只读显示。新建 / 删除 / 改属性请到网页端。",
        "settings.calendars.empty" to "还没有日历。",
        "settings.calendars.openOnWeb" to "在网页管理日历",

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
    )

    private val DICTIONARIES: Map<Locale, Map<String, String>> = mapOf(
        Locale.EN to en,
        Locale.ZH_CN to zhCN,
    )
}
