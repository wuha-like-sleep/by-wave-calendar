// Daos. v0.5: queries scope by profileId so switching profiles
// emits fresh data via Flow.

package cn.bywave.calendar.data.store

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
interface EventDao {
    @Query("SELECT * FROM events WHERE profileId = :profileId ORDER BY startsAt ASC")
    fun observeForProfile(profileId: String): Flow<List<EventEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(rows: List<EventEntity>)

    @Query("DELETE FROM events WHERE profileId = :profileId")
    suspend fun clearProfile(profileId: String)

    @Query("DELETE FROM events")
    suspend fun clearAll()

    @Transaction
    suspend fun replaceForProfile(profileId: String, rows: List<EventEntity>) {
        clearProfile(profileId)
        insertAll(rows)
    }
}

@Dao
interface CalendarDao {
    @Query("SELECT * FROM calendars WHERE profileId = :profileId ORDER BY name ASC")
    fun observeForProfile(profileId: String): Flow<List<CalendarEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(rows: List<CalendarEntity>)

    @Query("DELETE FROM calendars WHERE profileId = :profileId")
    suspend fun clearProfile(profileId: String)

    @Query("DELETE FROM calendars")
    suspend fun clearAll()

    @Transaction
    suspend fun replaceForProfile(profileId: String, rows: List<CalendarEntity>) {
        clearProfile(profileId)
        insertAll(rows)
    }
}
