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
    entities = [EventEntity::class, CalendarEntity::class, PendingOpEntity::class, AddressEntryEntity::class],
    version = 4,  // v4: address_entries（本地地址簿）。这一版给了真迁移
                  // （只有 CREATE TABLE，见 MIGRATION_3_4）：地址簿是
                  // 用户长期攒的数据，不该陪事件缓存一起被 destructive
                  // 回退清掉；且建表迁移本身零风险。其余版本跳跃仍走
                  // 既有 destructive 回退口径。
    exportSchema = false,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun eventDao(): EventDao
    abstract fun calendarDao(): CalendarDao
    abstract fun pendingOpDao(): PendingOpDao
    abstract fun addressDao(): AddressDao

    companion object {
        @Volatile private var instance: AppDatabase? = null

        /** v3 → v4：只新建地址簿表，不动任何既有数据。 */
        val MIGRATION_3_4 = object : androidx.room.migration.Migration(3, 4) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS address_entries (" +
                        "normalized TEXT NOT NULL PRIMARY KEY, " +
                        "address TEXT NOT NULL, " +
                        "useCount INTEGER NOT NULL, " +
                        "lastUsedAt INTEGER NOT NULL, " +
                        "firstSeenAt INTEGER NOT NULL, " +
                        "source TEXT NOT NULL, " +
                        "street TEXT, suburb TEXT, city TEXT, state TEXT, " +
                        "postcode TEXT, country TEXT, lat REAL, lon REAL, " +
                        "keywordsJson TEXT NOT NULL)",
                )
            }
        }

        fun get(context: Context): AppDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                AppDatabase::class.java,
                "bywave-cache-v1.db",
            )
                .addMigrations(MIGRATION_3_4)
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
