// Room database. Schema version starts at 1; bump + add a Migration
// when we change Entities in a backward-incompatible way. Until v1.0
// we use fallbackToDestructiveMigration() so dev iterations don't
// require writing migration code for every schema tweak.

package cn.bywave.calendar.data.store

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.withTransaction

@Database(
    entities = [EventEntity::class, CalendarEntity::class, PendingOpEntity::class],
    version = 3,  // v3: pending_ops（离线写队列）。仍走 destructive 回退：
                  // 升级丢的是可重拉的事件缓存；队列在升级那一刻若非空
                  // 会一并丢——与既有「未到 1.0 不写迁移」的取舍一致，
                  // 且队列条目对应的本地改动本就只在缓存里，缓存清了
                  // 条目留着反而会把不存在的事件往服务端推。
    exportSchema = false,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun eventDao(): EventDao
    abstract fun calendarDao(): CalendarDao
    abstract fun pendingOpDao(): PendingOpDao

    companion object {
        @Volatile private var instance: AppDatabase? = null

        fun get(context: Context): AppDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                AppDatabase::class.java,
                "bywave-cache-v1.db",
            )
                .fallbackToDestructiveMigration()
                .build()
                .also { instance = it }
        }

        /** Wipe everything. Called on "sign out all" so the next user
         *  starts with an empty cache. */
        suspend fun wipeAll(context: Context) {
            val db = get(context)
            db.withTransaction {
                db.eventDao().clearAll()
                db.calendarDao().clearAll()
            }
        }

        /** Wipe just one profile's cache (sign out from one account
         *  but keep the others). */
        suspend fun wipeProfile(context: Context, profileId: String) {
            val db = get(context)
            db.withTransaction {
                db.eventDao().clearProfile(profileId)
                db.calendarDao().clearProfile(profileId)
            }
        }
    }
}
