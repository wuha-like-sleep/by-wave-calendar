// Application singleton + dependency container. v0.5 replaces the
// single-account TokenStore with the multi-account ProfileStore.
// Hilt / Koin would be reasonable upgrades once we have more
// dependencies; at this stage the manual locator is still clearer.

package cn.bywave.calendar

import android.app.Application
import android.content.Context
import cn.bywave.calendar.data.auth.ProfileStore
import cn.bywave.calendar.data.store.EventRepository
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
    }

    companion object {
        @Volatile lateinit var instance: BywaveApp
            private set
    }
}
