// LocaleHelper.kt
// APP 内「界面语言」的唯一落地点。
//
// 为什么不用 AppCompatDelegate.setApplicationLocales：
//   那个 API 在 Android 13 以下是靠 **AppCompat 自己的 Activity**
//   （AppCompatActivity.attachBaseContext）把 Configuration 换掉的。本仓是
//   纯 Compose：MainActivity 是 ComponentActivity，主题是
//   android:Theme.Material.Light.NoActionBar，manifest 里也没有
//   AppLocalesMetadataHolderService。三者都不满足，于是 API ≤ 32 上
//   setApplicationLocales() 调用成功、返回成功、什么都不会发生 ——
//   用户选了「日本語」，界面不变、日期不变、重启也不变，而设置页那一行
//   已经显示「日本語」。而 Android 13 以下恰恰是这个开关唯一的服务对象
//   （13+ 系统设置里本来就有「应用语言」）。
//
// 为什么不改成 AppCompatActivity + AppCompat 主题：
//   那要求把 themes.xml 的 parent 换成 Theme.AppCompat.*，整个启动窗口
//   （splash 那一帧）的背景/状态栏都跟着换一套默认值，为了一个语言开关
//   动全局主题，回归面比收益大。这里改成平台能力 + 自己换 Configuration：
//     - Android 13+：平台 LocaleManager，和系统设置里的「应用语言」是同
//       一份状态，用户从哪条路改都一致；
//     - Android 12 及以下：BywaveApp / MainActivity 的 attachBaseContext
//       里 createConfigurationContext(带目标 locale)。
//   两条路都不碰主题，也不再需要 androidx.appcompat 这个依赖。
//
// 我们仍然自己存一份用户的选择（SharedPreferences）：
//   12 及以下没有任何平台状态可查，冷启动时只能从自己这份恢复。
//   13+ 上平台是权威来源，我们这份只是镜像（applyEarly 会以平台为准回写）。
//
// Storage: ~/data/data/cn.bywave.calendar/shared_prefs/bwc_prefs.xml
// （plain SharedPreferences；存的是 5 个字符左右的语言代码，非敏感。）

package cn.bywave.calendar.i18n

import android.app.Activity
import android.app.LocaleManager
import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.State
import cn.bywave.calendar.R
import java.util.Locale

object LocaleHelper {

    /** 能选的语言。顺序 = 选择器里的顺序。
     *
     *  标签一律用该语言自己的写法（endonym），不跟界面语言走：找「日本語」
     *  的人正在看一个他读不懂的界面，把这一项翻译成中文的「日语」等于让他
     *  认不出来。这也是各家 APP 语言选择器的通行做法。
     *
     *  「跟随系统」是唯一的例外——它描述的是一个行为而不是一门语言，所以
     *  从 strings 里取，跟着当前界面语言走。 */
    val languages: List<Pair<String, String>> = listOf(
        "zh-Hans" to "简体中文",
        // "zh-TW"（BCP-47）解析到 values-zh-rTW 资源目录。
        "zh-TW"   to "繁體中文",
        "en"      to "English",
        "ja"      to "日本語",
        "ko"      to "한국어",
        "es"      to "Español",
        "fr"      to "Français",
        "de"      to "Deutsch",
    )

    private const val PREFS_NAME = "bwc_prefs"
    private const val KEY = "bwc.locale"

    /** 13+ 上「我们存的这份已经交给平台 LocaleManager 了」。
     *
     *  没有这个标记的话分不清两种「平台那边是空的」：
     *    a) 从旧版本升上来，平台还没听说过我们存的选择 —— 该推给它；
     *    b) 用户刚在系统设置里把应用语言改回「系统默认」 —— 不该推回去，
     *       那是跟用户抢方向盘。
     *  以前那版会把 b 也当成 a，用户在系统设置里怎么清都清不掉。 */
    private const val KEY_PLATFORM_SYNCED = "bwc.locale.platform_synced"

    /** Backing mutable state so Compose Settings UI re-renders on
     *  change without us threading a callback through. */
    private val _state = mutableStateOf("")
    val current: State<String> get() = _state

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun savedTag(ctx: Context): String = prefs(ctx).getString(KEY, "").orEmpty()

    private fun store(ctx: Context, code: String) {
        prefs(ctx).edit().putString(KEY, code).apply()
    }

    private fun markPlatformSynced(ctx: Context) {
        prefs(ctx).edit().putBoolean(KEY_PLATFORM_SYNCED, true).apply()
    }

    private fun platformSynced(ctx: Context): Boolean =
        prefs(ctx).getBoolean(KEY_PLATFORM_SYNCED, false)

    /** Call from BywaveApp.onCreate() — 恢复用户存过的语言选择。Idempotent。 */
    fun applyEarly(ctx: Context) {
        val saved = savedTag(ctx)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val lm = ctx.getSystemService(LocaleManager::class.java)
            val platform = lm?.applicationLocales
            val platformTag = platform
                ?.takeIf { !it.isEmpty }
                ?.get(0)
                ?.toLanguageTag()
                .orEmpty()
            when {
                // 13+ 上系统设置里也有一条「应用语言」，用户可能从那条路改。
                // 平台说了算，我们这份跟着回写，免得两处显示不一致。
                platformTag.isNotEmpty() -> {
                    val normalized = normalizeToKnown(platformTag)
                    _state.value = normalized
                    if (normalized != saved) store(ctx, normalized)
                    markPlatformSynced(ctx)
                }
                // 从旧版本升上来：平台还不知道我们存过的选择，推给它一次。
                // 只推这一次 —— 推完打标记，之后平台说了算。
                saved.isNotEmpty() && !platformSynced(ctx) -> {
                    _state.value = saved
                    lm?.applicationLocales = LocaleList.forLanguageTags(saved)
                    markPlatformSynced(ctx)
                }
                // 平台是空的，而且我们早就同步过了 = 用户自己在系统设置里
                // 改回了「系统默认」。跟着清掉，别把旧选择推回去。
                else -> {
                    _state.value = ""
                    if (saved.isNotEmpty()) store(ctx, "")
                }
            }
        } else {
            // 12 及以下：真正生效的地方在 wrap()（attachBaseContext），
            // 这里只把状态读进来给设置页显示。
            _state.value = saved
            if (saved.isNotEmpty()) Locale.setDefault(Locale.forLanguageTag(saved))
        }
    }

    /**
     * 切换语言。空串 = 「跟随系统」= 清掉覆盖。
     *
     * 13+ 交给平台，平台自己会重建 Activity；12 及以下我们换完存档之后
     * 手动 recreate()，让 attachBaseContext 带着新 locale 再跑一遍。
     */
    fun setLocale(ctx: Context, code: String) {
        if (code == _state.value) return
        store(ctx, code)
        _state.value = code
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val lm = ctx.getSystemService(LocaleManager::class.java)
            lm?.applicationLocales =
                if (code.isEmpty()) LocaleList.getEmptyLocaleList()
                else LocaleList.forLanguageTags(code)
            markPlatformSynced(ctx)
        } else {
            if (code.isEmpty()) {
                // 跟随系统：把进程默认 Locale 还回去，否则「切回跟随系统」
                // 之后 Locale.getDefault() 还停在上一门语言上。
                Locale.setDefault(systemLocale(ctx))
            } else {
                Locale.setDefault(Locale.forLanguageTag(code))
            }
            ctx.findActivity()?.recreate()
        }
    }

    /**
     * attachBaseContext 用。Android 12 及以下把 base 换成一份带目标语言的
     * Context —— 这是这条路上**唯一**真正让 8 种语言生效的地方。
     *
     * 13+ 原样返回：平台 LocaleManager 已经把 Configuration 改好了，
     * 这里再包一层反而会把用户从系统设置那条路改的语言盖掉。
     */
    fun wrap(base: Context): Context {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return base
        val saved = savedTag(base)
        if (saved.isEmpty()) return base
        val locale = Locale.forLanguageTag(saved)
        Locale.setDefault(locale)
        val config = Configuration(base.resources.configuration)
        val list = LocaleList(locale)
        LocaleList.setDefault(list)
        config.setLocales(list)
        return base.createConfigurationContext(config)
    }

    /** 设置页那一行的副标题。 */
    fun currentLabel(ctx: Context): String {
        val cur = _state.value
        if (cur.isEmpty()) {
            // 「跟随系统」后面补一句现在实际落到了哪门语言。之前这里只认
            // zh 和 en，其余语言直接把 "ja" / "ko" 这样的语言代码显示给用户看。
            val resolved = resolvedLabel(ctx)
            return if (resolved.isEmpty()) ctx.getString(R.string.settings_language_follow_system)
                   else ctx.getString(R.string.settings_language_follow_system_detail, resolved)
        }
        return languages.firstOrNull { it.first == cur }?.second ?: cur
    }

    /** 当前实际生效的语言的自称。先在我们支持的列表里按语言+地区匹配，
     *  匹配不上就退回系统给的自称（总比显示 "ja" 强）。 */
    private fun resolvedLabel(ctx: Context): String {
        val sys = ctx.resources.configuration.locales[0] ?: return ""
        matching(sys)?.let { return it.second }
        return sys.getDisplayName(sys)
    }

    /** 平台回给我们的 tag 可能带地区/文字（zh-Hans-CN、de-DE），
     *  归一到 languages 里的写法，好让设置页那一行对得上。
     *  internal 是为了能在纯 JVM 单测里直接打它 —— 这条判断错了不报任何错，
     *  只会让用户的语言被静默改掉。 */
    internal fun normalizeToKnown(tag: String): String {
        val locale = Locale.forLanguageTag(tag)
        return matching(locale)?.first ?: tag
    }

    /**
     * 把一个 locale 匹配到 languages 里的一项。
     *
     * 以前是「第一个大致对得上的就算」：`l.country.isEmpty() || …` 和
     * `l.script.isEmpty() || locale.script.isEmpty() || …` 两个条件在
     * 「两边都没说」时互相放行。而 languages 的第一项 zh-Hans 的 country 是空、
     * script 是 Hans，平台回给我们的偏偏是 **zh-TW**（没有 script、country=TW）
     * —— 于是 zh-Hans 把 zh-TW 吃掉了。
     *
     * 表现：繁體中文用户冷启动一次，界面还是繁体，设置页那一行却显示「简体中文」；
     * 想点回去点「简体中文」又完全没反应（setLocale 认为语言没变、提前返回）；
     * 同时存下来的偏好被静默改写成 zh-Hans，连带发往服务端的页面链接也变简体。
     *
     * 中文是这个列表里唯一一门靠文字/地区分繁简的语言，所以单独判；
     * 其余几门只有裸语言码，按语言匹配就够，靠通用规则去猜只会再猜错一次。
     */
    private fun matching(locale: Locale): Pair<String, String>? {
        if (locale.language == "zh") {
            val traditional = locale.script == "Hant" || locale.country in TRADITIONAL_REGIONS
            val want = if (traditional) "zh-TW" else "zh-Hans"
            return languages.firstOrNull { it.first == want }
        }
        return languages.firstOrNull { (tag, _) ->
            Locale.forLanguageTag(tag).language == locale.language
        }
    }

    /** 用繁体的中文地区。zh-SG（新加坡）用简体，不在这里。 */
    private val TRADITIONAL_REGIONS = setOf("TW", "HK", "MO")

    /** 12 及以下「跟随系统」要还原到的那门语言。Configuration 此刻可能已经
     *  被我们换过，所以从系统资源里取。 */
    private fun systemLocale(ctx: Context): Locale =
        android.content.res.Resources.getSystem().configuration.locales[0]
            ?: Locale.getDefault()

    private fun Context.findActivity(): Activity? {
        var c: Context? = this
        while (c is ContextWrapper) {
            if (c is Activity) return c
            c = c.baseContext
        }
        return null
    }
}
