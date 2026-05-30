// Profile switcher — dropdown anchored to the sidebar header.
// Shows the active profile's email + server, expands to a list of
// other paired profiles with a "添加账号" entry at the bottom and a
// per-profile remove button.

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.model.Profile

@Composable
fun ProfileSwitcher(
    active: Profile,
    profiles: List<Profile>,
    onSelect: (String) -> Unit,
    onAddAccount: () -> Unit,
    onRemove: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    // Observe locale so the dropdown labels re-render on language switch.
    val locale by cn.bywave.calendar.desktop.i18n.I18n.current.collectAsState()
    val t = remember(locale) { { key: String -> cn.bywave.calendar.desktop.i18n.I18n.t(key) } }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface)
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(10.dp),
    ) {
        // Active profile summary — clicking it opens the switcher.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(6.dp))
                .background(MaterialTheme.colorScheme.surface),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(6.dp))
                    .padding(4.dp),
            ) {
                Text(
                    active.email,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    active.serverUrl,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.outline,
                )
            }
            Box {
                IconButton(onClick = { open = !open }) {
                    Text("▾", style = MaterialTheme.typography.titleMedium)
                }
                DropdownMenu(
                    expanded = open,
                    onDismissRequest = { open = false },
                ) {
                    for (p in profiles) {
                        val isActive = p.deviceId == active.deviceId
                        DropdownMenuItem(
                            text = {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.width(280.dp),
                                ) {
                                    Box(modifier = Modifier.size(16.dp)) {
                                        if (isActive) Icon(
                                            Icons.Default.Check,
                                            contentDescription = t("profile.current"),
                                            tint = MaterialTheme.colorScheme.primary,
                                            modifier = Modifier.size(16.dp),
                                        )
                                    }
                                    Spacer(Modifier.width(8.dp))
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(p.email, style = MaterialTheme.typography.bodyMedium)
                                        Text(
                                            p.serverUrl,
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.outline,
                                        )
                                    }
                                    // Remove (X) button. Hidden on the
                                    // active row to avoid an accidental
                                    // "sign me out while I'm logged in"
                                    // tap — sign-out is the explicit
                                    // top-bar button.
                                    if (!isActive) {
                                        IconButton(
                                            onClick = { onRemove(p.deviceId); open = false },
                                            modifier = Modifier.size(24.dp),
                                        ) {
                                            Icon(
                                                Icons.Default.Close,
                                                contentDescription = t("profile.remove"),
                                                tint = MaterialTheme.colorScheme.outline,
                                                modifier = Modifier.size(14.dp),
                                            )
                                        }
                                    }
                                }
                            },
                            onClick = {
                                if (!isActive) onSelect(p.deviceId)
                                open = false
                            },
                        )
                    }
                    HorizontalDivider()
                    DropdownMenuItem(
                        text = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    Icons.Default.Add,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(t("profile.add"), style = MaterialTheme.typography.bodyMedium)
                            }
                        },
                        onClick = {
                            onAddAccount()
                            open = false
                        },
                    )
                }
            }
        }
    }
}
