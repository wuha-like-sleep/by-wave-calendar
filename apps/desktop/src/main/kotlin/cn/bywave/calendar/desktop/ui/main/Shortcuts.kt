// Desktop keyboard shortcuts. Hooked at the Window level via
// onPreviewKeyEvent → emit onto a SharedFlow that MainScreen collects.
// We use a top-level object as the bus so the Window doesn't have to
// know about CalendarState (which is per-screen and rebuilt on profile
// change). MainScreen mounts a collector when a state is available;
// when it unmounts (e.g. signed out → Setup), shortcuts harmlessly
// drop until the next collector arrives.

package cn.bywave.calendar.desktop.ui.main

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow

enum class ShortcutAction {
    /** Open the new-event dialog. Cmd/Ctrl + N. */
    New,
    /** Refetch the current window. Cmd/Ctrl + R. */
    Refresh,
    /** Go back one (day/week/month per current view). Cmd/Ctrl + Left. */
    Previous,
    /** Go forward one. Cmd/Ctrl + Right. */
    Next,
    /** Jump to today. Cmd/Ctrl + T. */
    Today,
    /** Close any open sheet/dialog. Escape (the only single-key binding —
     *  safe because text fields don't navigate with it and dialogs
     *  intercepting Esc to close is expected behavior). */
    Escape,
    /** Force-check for an APP update. Cmd/Ctrl + U. Also surfaced as
     *  a MenuBar item. */
    CheckUpdate,
    /** Open the Settings page. Cmd/Ctrl + , — same shortcut as macOS
     *  app settings convention (System Settings, Safari, etc.). */
    OpenSettings,
    /** Open the global event search dialog. Cmd/Ctrl + F — the universal
     *  "find" shortcut; matches the web Cmd+K palette / iOS search. */
    OpenSearch,
    /** Switch the calendar view. Cmd/Ctrl + 1/2/3/4 → Day/Week/Month/Agenda
     *  — the digit-to-view convention from Google Calendar / Fantastical. */
    ViewDay,
    ViewWeek,
    ViewMonth,
    ViewAgenda,
}

object ShortcutBus {
    /** SharedFlow with buffer 1 + DROP_OLDEST so a burst of taps while
     *  the collector is asleep (e.g. dialog focus elsewhere) doesn't
     *  build up — only the last action wins. */
    val flow: MutableSharedFlow<ShortcutAction> = MutableSharedFlow(
        replay = 0,
        extraBufferCapacity = 1,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
}

/** Translates a KeyEvent into a ShortcutAction. Everything except Esc
 *  is gated on Cmd (macOS) or Ctrl (Win/Linux) being held, so plain
 *  letters/arrows still work inside text fields. */
fun keyEventToShortcut(e: KeyEvent): ShortcutAction? {
    if (e.type != KeyEventType.KeyDown) return null
    val mod = e.isMetaPressed || e.isCtrlPressed
    return when {
        mod && e.key == Key.N -> ShortcutAction.New
        mod && e.key == Key.R -> ShortcutAction.Refresh
        mod && e.key == Key.T -> ShortcutAction.Today
        mod && e.key == Key.DirectionLeft -> ShortcutAction.Previous
        mod && e.key == Key.DirectionRight -> ShortcutAction.Next
        mod && e.key == Key.U -> ShortcutAction.CheckUpdate
        mod && e.key == Key.F -> ShortcutAction.OpenSearch
        mod && e.key == Key.Comma -> ShortcutAction.OpenSettings
        mod && e.key == Key.One -> ShortcutAction.ViewDay
        mod && e.key == Key.Two -> ShortcutAction.ViewWeek
        mod && e.key == Key.Three -> ShortcutAction.ViewMonth
        mod && e.key == Key.Four -> ShortcutAction.ViewAgenda
        !mod && e.key == Key.Escape -> ShortcutAction.Escape
        else -> null
    }
}
