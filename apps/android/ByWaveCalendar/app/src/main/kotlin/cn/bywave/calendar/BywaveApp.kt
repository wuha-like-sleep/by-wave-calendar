// Application singleton + dependency container. v0.5 replaces the
// single-account TokenStore with the multi-account ProfileStore.
// Hilt / Koin would be reasonable upgrades once we have more
// dependencies; at this stage the manual locator is still clearer.

package cn.bywave.calendar

import android.app.Application
import cn.bywave.calendar.data.auth.ProfileStore
import cn.bywave.calendar.data.store.EventRepository

class BywaveApp : Application() {
    val profiles: ProfileStore by lazy { ProfileStore(this) }
    val repository: EventRepository by lazy { EventRepository(this, profiles) }

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        @Volatile lateinit var instance: BywaveApp
            private set
    }
}
