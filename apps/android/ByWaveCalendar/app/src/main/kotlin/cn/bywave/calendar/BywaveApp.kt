// Application singleton. We use it as the dependency container for now
// — TokenStore + ApiClient live here instead of behind a DI framework.
// Hilt / Koin would be reasonable upgrades once we have more dependencies,
// but at v0.1 the overhead isn't justified.

package cn.bywave.calendar

import android.app.Application
import cn.bywave.calendar.data.auth.TokenStore
import cn.bywave.calendar.data.store.EventRepository

class BywaveApp : Application() {
    /** Initialized lazily so unit-test variants can inject a fake. */
    val tokenStore: TokenStore by lazy { TokenStore(this) }
    val repository: EventRepository by lazy { EventRepository(this, tokenStore) }

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        @Volatile lateinit var instance: BywaveApp
            private set
    }
}
