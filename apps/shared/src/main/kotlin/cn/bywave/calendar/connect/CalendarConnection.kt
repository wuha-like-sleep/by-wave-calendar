package cn.bywave.calendar.connect

import kotlinx.serialization.Serializable

@Serializable data class SyncCalendar(val id: String, val name: String, val color: String? = null)
@Serializable data class SyncAccount(val label: String)
@Serializable data class SyncLogin(val userCode: String, val verificationUri: String, val expiresAt: String, val interval: Int)
@Serializable data class SyncContent(val summary: String, val startsAt: String, val endsAt: String, val location: String = "", val description: String = "")
@Serializable data class SyncItem(val content: SyncContent, val revision: String)
@Serializable data class SyncConflict(val key: String, val left: SyncItem? = null, val right: SyncItem? = null)
@Serializable data class SyncPair(val id: String, val calendarId: String, val remoteId: String, val remoteName: String, val enabled: Boolean, val conflicts: List<SyncConflict> = emptyList(), val error: String? = null, val lastSyncedAt: String? = null)
@Serializable data class CalendarPassword(val id: String, val label: String, val lastUsedAt: String? = null, val calendarIds: List<String>? = null, val paused: Boolean = false)
@Serializable data class AppleConnection(val available: Boolean, val serverUrl: String, val username: String, val passwords: List<CalendarPassword> = emptyList())
@Serializable data class CalendarConnection(val configured: Boolean, val account: SyncAccount? = null, val calendars: List<SyncCalendar> = emptyList(), val pairs: List<SyncPair> = emptyList(), val login: SyncLogin? = null, val remote: List<SyncCalendar>? = null, val remoteError: Boolean = false, val apple: AppleConnection)
@Serializable data class CalendarCommand(val action: String, val id: String? = null, val calendarId: String? = null, val remoteId: String? = null, val key: String? = null, val side: String? = null, val confirm: String? = null, val label: String? = null, val calendarIds: List<String>? = null, val paused: Boolean? = null, val leftRevision: String? = null, val rightRevision: String? = null)
@Serializable data class IssuedCalendarPassword(val id: String, val plain: String)
@Serializable data class CalendarCommandResult(val saved: Boolean = false, val password: IssuedCalendarPassword? = null)
@Serializable data class AppleProfile(val profile: String)

/** Receives only app credentials; Microsoft refresh/device tokens stay on the server. */
interface CalendarConnectionApi {
    suspend fun load(remote: Boolean): CalendarConnection
    suspend fun command(command: CalendarCommand): CalendarCommandResult
    suspend fun appleProfile(): AppleProfile
}
