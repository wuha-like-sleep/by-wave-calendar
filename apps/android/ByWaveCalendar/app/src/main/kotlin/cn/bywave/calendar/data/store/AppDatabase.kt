// Room database. Schema version starts at 1; bump + add a Migration
// when we change Entities in a backward-incompatible way. Until v1.0
// we use fallbackToDestructiveMigration() so dev iterations don't
// require writing migration code for every schema tweak.

package cn.bywave.calendar.data.store

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [EventEntity::class, CalendarEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun eventDao(): EventDao
    abstract fun calendarDao(): CalendarDao

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

        /** Wipe everything. Called on sign-out so the next user starts
         *  with an empty cache. */
        suspend fun wipe(context: Context) {
            val db = get(context)
            db.eventDao().clear()
            db.calendarDao().clear()
        }
    }
}
