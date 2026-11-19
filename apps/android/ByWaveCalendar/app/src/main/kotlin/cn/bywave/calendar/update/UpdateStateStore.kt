// 宽限期的「第一次发现」时刻，按 versionCode 持久化。
//
// 宽限口径（与桌面端一致，判定在 shared 的 Rollout.forceState）：被
// 强升命中后，从第一次发现这个版本起 graceDays 天内只提醒、过后才
// 强升。这个「第一次」必须落盘且之后绝不刷新 —— 存在内存里的话每次
// 冷启动都重新计时，宽限永远不到期；每次检查都刷新同理。

package cn.bywave.calendar.update

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

private val Context.updateStateStore by preferencesDataStore(name = "bwc-update-state")
private val KEY_FIRST_SEEN_VERSION = intPreferencesKey("force_first_seen_version")
private val KEY_FIRST_SEEN_AT = longPreferencesKey("force_first_seen_at")

object UpdateStateStore {
    /** 这个 versionCode 第一次被发现的时刻。已存的是别的版本（或没存过）
     *  就以现在为第一次并落盘；存的就是这个版本则原样返回，不刷新。 */
    suspend fun firstSeenMillis(context: Context, versionCode: Int): Long {
        val ds = context.applicationContext.updateStateStore
        val prefs = ds.data.first()
        if (prefs[KEY_FIRST_SEEN_VERSION] == versionCode) {
            prefs[KEY_FIRST_SEEN_AT]?.let { return it }
        }
        val now = System.currentTimeMillis()
        ds.edit {
            it[KEY_FIRST_SEEN_VERSION] = versionCode
            it[KEY_FIRST_SEEN_AT] = now
        }
        return now
    }
}
