// Daos. Reactive Flow returns so CalendarViewModel can `combine()` and
// re-render automatically when the network fetch writes back into the
// cache.
//
// We use clear-and-insert (replaceAll) on every successful network
// fetch because we always fetch the entire 15-month window — easier
// to reason about than incremental upserts, and the rows are small.

package cn.bywave.calendar.data.store

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
interface EventDao {
    @Query("SELECT * FROM events ORDER BY startsAt ASC")
    fun observeAll(): Flow<List<EventEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(rows: List<EventEntity>)

    @Query("DELETE FROM events")
    suspend fun clear()

    @Transaction
    suspend fun replaceAll(rows: List<EventEntity>) {
        clear()
        insertAll(rows)
    }
}

@Dao
interface CalendarDao {
    @Query("SELECT * FROM calendars ORDER BY name ASC")
    fun observeAll(): Flow<List<CalendarEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(rows: List<CalendarEntity>)

    @Query("DELETE FROM calendars")
    suspend fun clear()

    @Transaction
    suspend fun replaceAll(rows: List<CalendarEntity>) {
        clear()
        insertAll(rows)
    }
}
