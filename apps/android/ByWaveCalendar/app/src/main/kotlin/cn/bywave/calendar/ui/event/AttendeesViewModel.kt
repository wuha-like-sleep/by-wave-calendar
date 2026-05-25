// AttendeesViewModel — backs AttendeesScreen. Mirrors iOS
// AttendeesPage's load / invite / revoke flow against the
// /api/v1/events/:id/attendees endpoints.
//
// The list is owned by this VM (not Room) because attendees are a
// per-event sub-resource and re-fetching is cheap. Inviting / revoking
// updates the list optimistically and then re-fetches on success to
// reflect server-side state (e.g. pending vs accepted, server may
// merge duplicate invites).

package cn.bywave.calendar.ui.event

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.model.AttendeeInviteRequest
import cn.bywave.calendar.data.model.AttendeeRevokeRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AttendeesUiState(
    val attendees: List<String> = emptyList(),
    val loading: Boolean = false,
    val sending: Boolean = false,
    val emailInput: String = "",
    val errorMessage: String? = null,
)

class AttendeesViewModel : ViewModel() {
    private val profiles = BywaveApp.instance.profiles
    private val _state = MutableStateFlow(AttendeesUiState())
    val state: StateFlow<AttendeesUiState> = _state.asStateFlow()

    private var eventId: String = ""

    fun bootstrap(eventId: String) {
        if (this.eventId == eventId && _state.value.attendees.isNotEmpty()) return
        this.eventId = eventId
        load()
    }

    fun onEmailInput(v: String) = _state.update { it.copy(emailInput = v, errorMessage = null) }

    fun invite() {
        val email = _state.value.emailInput.trim()
        if (!isValidEmail(email)) {
            _state.update { it.copy(errorMessage = "请输入合法邮箱") }
            return
        }
        _state.update { it.copy(sending = true, errorMessage = null) }

        viewModelScope.launch {
            try {
                val client = client() ?: return@launch
                client.api.inviteAttendee(eventId, AttendeeInviteRequest(email))
                _state.update { it.copy(sending = false, emailInput = "") }
                load()  // refetch to pick up server-side normalization
            } catch (e: Exception) {
                _state.update {
                    it.copy(sending = false, errorMessage = e.localizedMessage ?: "邀请失败")
                }
            }
        }
    }

    fun revoke(email: String) {
        viewModelScope.launch {
            // Optimistic remove — restored from server on next load if
            // the call fails.
            val previous = _state.value.attendees
            _state.update { it.copy(attendees = previous.filterNot { e -> e == email }) }
            try {
                val client = client() ?: return@launch
                client.api.revokeAttendee(eventId, AttendeeRevokeRequest(email))
                load()
            } catch (e: Exception) {
                _state.update {
                    it.copy(attendees = previous, errorMessage = e.localizedMessage ?: "撤销失败")
                }
            }
        }
    }

    private fun load() {
        _state.update { it.copy(loading = true) }
        viewModelScope.launch {
            try {
                val client = client() ?: return@launch
                val resp = client.api.attendees(eventId)
                _state.update {
                    it.copy(loading = false, attendees = resp.attendees)
                }
            } catch (e: Exception) {
                _state.update {
                    it.copy(loading = false, errorMessage = e.localizedMessage ?: "加载邀请人失败")
                }
            }
        }
    }

    private fun client(): ApiClient? {
        val profile = profiles.active() ?: run {
            _state.update { it.copy(errorMessage = "未登录") }
            return null
        }
        return ApiClient.forProfile(profile, profiles)
    }

    private fun isValidEmail(s: String): Boolean =
        s.matches(Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"))
}
