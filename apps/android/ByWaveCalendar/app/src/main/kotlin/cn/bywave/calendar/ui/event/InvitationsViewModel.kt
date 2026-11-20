// InvitationsViewModel — backs InvitationsScreen (invitee side).
//
// The list comes from GET /api/v1/invitations, which already carries
// everything the detail page needs (organizer, full invitee list with
// per-person RSVP status, my proposals, display timezone), so this VM
// is a thin state holder: load → select → respond / propose → reload.
// Mutations NEVER update local state optimistically: the server is the
// RSVP source of truth, and a failed respond must not look successful.

package cn.bywave.calendar.ui.event

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.bywave.calendar.BywaveApp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.api.ApiClient
import cn.bywave.calendar.data.api.serverErrorMessage
import cn.bywave.calendar.data.model.Invitation
import cn.bywave.calendar.data.model.InvitationProposeRequest
import cn.bywave.calendar.data.model.InvitationRespondRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class InvitationsUiState(
    val invitations: List<Invitation> = emptyList(),
    val loading: Boolean = false,
    val errorMessage: String? = null,
    /** Token of the invitation whose detail is open; null = list. */
    val selectedToken: String? = null,
    /** A respond / propose call is in flight — buttons disable. */
    val acting: Boolean = false,
    /** Last mutation failure, shown on the detail page (not the list). */
    val actionError: String? = null,
)

class InvitationsViewModel : ViewModel() {
    private val app = BywaveApp.instance
    private val profiles = app.profiles
    private val _state = MutableStateFlow(InvitationsUiState())
    val state: StateFlow<InvitationsUiState> = _state.asStateFlow()

    private var bootstrapped = false

    /** [openToken] comes from a deep link (bywave://invitations/<token>):
     *  once the list lands, jump straight to that invitation's detail. */
    fun bootstrap(openToken: String?) {
        if (bootstrapped) {
            if (openToken != null) select(openToken)
            return
        }
        bootstrapped = true
        if (openToken != null) _state.update { it.copy(selectedToken = openToken) }
        load()
    }

    fun select(token: String?) {
        _state.update { it.copy(selectedToken = token, actionError = null) }
    }

    fun respond(status: String) {
        val token = _state.value.selectedToken ?: return
        mutate {
            val client = client() ?: return@mutate
            client.api.respondInvitation(token, InvitationRespondRequest(status))
        }
    }

    fun propose(startsAtIso: String, endsAtIso: String, note: String?) {
        val token = _state.value.selectedToken ?: return
        mutate {
            val client = client() ?: return@mutate
            client.api.proposeInvitation(
                token,
                InvitationProposeRequest(startsAtIso, endsAtIso, note?.takeIf { it.isNotBlank() }),
            )
        }
    }

    private fun mutate(block: suspend () -> Unit) {
        if (_state.value.acting) return
        _state.update { it.copy(acting = true, actionError = null) }
        viewModelScope.launch {
            try {
                block()
                _state.update { it.copy(acting = false) }
                load() // re-read statuses / proposals from the server
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        acting = false,
                        actionError = serverErrorMessage(e)
                            ?: e.localizedMessage
                            ?: app.getString(R.string.invitations_err_respond),
                    )
                }
            }
        }
    }

    fun load() {
        _state.update { it.copy(loading = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                val client = client() ?: return@launch
                val resp = client.api.invitations()
                _state.update { it.copy(loading = false, invitations = resp.invitations) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        loading = false,
                        errorMessage = serverErrorMessage(e)
                            ?: e.localizedMessage
                            ?: app.getString(R.string.invitations_err_load),
                    )
                }
            }
        }
    }

    private fun client(): ApiClient? {
        val profile = profiles.active() ?: run {
            _state.update {
                it.copy(loading = false, errorMessage = app.getString(R.string.attendees_err_not_logged_in))
            }
            return null
        }
        return ApiClient.forProfile(profile, profiles)
    }
}
