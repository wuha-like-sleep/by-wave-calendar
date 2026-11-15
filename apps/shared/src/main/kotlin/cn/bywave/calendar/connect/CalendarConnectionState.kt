package cn.bywave.calendar.connect

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** The command succeeded, but its updated status could not be fetched. */
class CalendarStatusRefreshFailed(cause: Exception) : Exception(cause)

/** Owned by one calendar settings screen and accessed on its UI dispatcher. */
class CalendarConnectionState(private val api: CalendarConnectionApi) {
    var data by mutableStateOf<CalendarConnection?>(null)
        private set
    var refreshing by mutableStateOf(false)
        private set
    var operating by mutableStateOf(false)
        private set
    var error by mutableStateOf<Exception?>(null)
        private set

    // Background reads must not lock the controls or release an operation's lock.
    val busy: Boolean get() = operating || (refreshing && data == null)
    private var generation = 0L
    private var refreshTicket: Long? = null
    private var errorFromRefresh = false

    suspend fun refresh(remote: Boolean, quiet: Boolean = false) {
        if (operating || refreshTicket != null) return
        val ticket = ++generation
        refreshTicket = ticket
        refreshing = true
        try {
            read(remote || data == null || (data?.account != null && data?.remote == null && data?.remoteError == false), ticket)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (ticket == generation && (!quiet || data == null)) {
                error = e
                errorFromRefresh = true
            }
        } finally {
            if (refreshTicket == ticket) {
                refreshTicket = null
                refreshing = false
            }
        }
    }

    suspend fun perform(reload: Boolean = false, work: suspend () -> Unit) {
        if (operating) return
        val ticket = ++generation
        // An older read can finish or be cancelled without affecting this command.
        refreshTicket = null
        refreshing = false
        operating = true
        error = null
        errorFromRefresh = false
        try {
            work()
            currentCoroutineContext().ensureActive()
            if (reload) {
                try {
                    read(true, ticket)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    error = CalendarStatusRefreshFailed(e)
                    errorFromRefresh = true
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e
        } finally {
            operating = false
        }
    }

    private suspend fun read(remote: Boolean, ticket: Long) {
        val next = api.load(remote)
        currentCoroutineContext().ensureActive()
        if (ticket != generation) return
        val previous = data
        data = if (!remote && next.account != null && next.account == previous?.account) {
            next.copy(remote = previous.remote, remoteError = previous.remoteError)
        } else next
        if (errorFromRefresh) {
            error = null
            errorFromRefresh = false
        }
    }
}
