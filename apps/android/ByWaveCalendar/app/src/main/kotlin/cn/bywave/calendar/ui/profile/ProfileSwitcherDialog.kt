// ProfileSwitcherDialog — invoked from the avatar badge in
// CalendarScreen's top bar. Lists existing profiles with a ✓ on the
// active one, plus "Add another account" at the bottom. Mirrors iOS
// ProfileSwitcherView.

package cn.bywave.calendar.ui.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.R
import cn.bywave.calendar.data.auth.Profile

@Composable
fun ProfileSwitcherDialog(
    profiles: List<Profile>,
    activeId: String?,
    onPick: (Profile) -> Unit,
    onAddAccount: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.profilesw_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
                if (profiles.isEmpty()) {
                    Text(
                        text = stringResource(R.string.profilesw_no_profiles),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 16.dp),
                    )
                } else {
                    for (p in profiles.sortedByDescending { it.lastUsedAt }) {
                        ProfileRow(
                            profile = p,
                            isActive = p.id == activeId,
                            onClick = { onPick(p) },
                        )
                        HorizontalDivider()
                    }
                }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(onClick = onAddAccount)
                        .padding(vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Default.Add, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.size(12.dp))
                    Text(
                        text = stringResource(R.string.profilesw_add_account),
                        color = MaterialTheme.colorScheme.primary,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_close)) }
        },
    )
}

@Composable
private fun ProfileRow(profile: Profile, isActive: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Avatar circle with email initial
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.primary),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = profile.initial,
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
                style = MaterialTheme.typography.titleMedium,
            )
        }
        Spacer(Modifier.size(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = profile.email, fontWeight = FontWeight.Medium)
            // Strip scheme + trailing slash for compact display
            val display = profile.serverUrl
                .removePrefix("https://").removePrefix("http://")
                .removeSuffix("/")
            Text(
                text = display,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
        }
        if (isActive) {
            Icon(
                Icons.Default.Check,
                contentDescription = stringResource(R.string.profilesw_active_desc),
                tint = MaterialTheme.colorScheme.primary,
            )
        }
    }
}
