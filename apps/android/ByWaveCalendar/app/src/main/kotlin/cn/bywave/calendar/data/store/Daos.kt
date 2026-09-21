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

    /** 一次性读取。退出登录时要用它取消已排期的提醒——取消 PendingIntent
     *  必须能重建出当初那一个，所以得在清库**之前**把事件读出来。 */
    @Query("SELECT * FROM events WHERE profileId = :profileId")
    suspend fun listForProfile(profileId: String): List<EventEntity>

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

    /** 一次性读取。设置页改完「镜像到系统日历」要立刻重建镜像，那时候
     *  手上没有 Flow 的最新值，只能直接查一次。 */
    @Query("SELECT * FROM calendars WHERE profileId = :profileId")
    suspend fun listForProfile(profileId: String): List<CalendarEntity>

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
