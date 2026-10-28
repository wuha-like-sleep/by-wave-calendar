// Application singleton + dependency container. v0.5 replaces the
// single-account TokenStore with the multi-account ProfileStore.
// Hilt / Koin would be reasonable upgrades once we have more
// dependencies; at this stage the manual locator is still clearer.

package cn.bywave.calendar

import android.app.Application
import android.content.Context
import cn.bywave.calendar.data.auth.ProfileStore
import cn.bywave.calendar.data.store.EventRepository
import kotlinx.coroutines.launch
import cn.bywave.calendar.i18n.LocaleHelper

class BywaveApp : Application() {
    val profiles: ProfileStore by lazy { ProfileStore(this) }
    val repository: EventRepository by lazy { EventRepository(this, profiles) }

    // Android 12 及以下，APP 内语言是靠换 Context 的 Configuration 落地的
    // （13+ 交给平台 LocaleManager，wrap() 会原样返回）。Application 这一份
    // 管的是所有非 Activity 的取字符串场景：ViewModel 里的
    // BywaveApp.instance.getString(...)、通知文案、BootReceiver。
    // 只包 Activity 的话，那些地方会退回系统语言，出现半个界面是日语、
    // 报错气泡是中文。
    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(LocaleHelper.wrap(base))
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        // 把用户存过的语言选择读进来 / 在 13+ 上和平台对齐。真正换
        // Configuration 的动作在 attachBaseContext（12 及以下）或者平台
        // LocaleManager（13+）里，见 LocaleHelper.kt。
        LocaleHelper.applyEarly(this)
        // 被服务端踢掉的账号：和用户自己退出一样，把排好的提醒、系统日历里的镜像、
        // 本地缓存一起清掉。见 ProfileStore.markSignedOut。
        profiles.onPassiveRemoval = { gone ->
            appScope.launch { runCatching { repository.wipeProfileFully(gone) } }
        }
    }

    /** 不跟任何页面同生共死的后台活儿（清理被踢掉的账号这种）。 */
    private val appScope = kotlinx.coroutines.CoroutineScope(
        kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO,
    )

    companion object {
        @Volatile lateinit var instance: BywaveApp
            private set
    }
}
