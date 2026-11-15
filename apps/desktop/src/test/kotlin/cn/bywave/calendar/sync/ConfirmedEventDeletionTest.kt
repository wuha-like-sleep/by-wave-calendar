package cn.bywave.calendar.sync

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ConfirmedEventDeletionTest {
    @Test fun `single occurrence compares instants across timestamp offsets`() {
        val deletion = ConfirmedEventDeletion("series", "instance", "2026-11-16T09:00:00+08:00")
        assertTrue(deletion.removes("series", "2026-11-16T01:00:00.000Z"))
        assertFalse(deletion.removes("series", "2026-11-17T01:00:00Z"))
        assertFalse(deletion.removes("other-series", "2026-11-16T01:00:00Z"))
    }

    @Test fun `future deletion includes boundary but preserves earlier occurrences`() {
        val deletion = ConfirmedEventDeletion("series", "future", "2026-11-16T01:00:00Z")
        assertFalse(deletion.removes("series", "2026-11-15T01:00:00Z"))
        assertTrue(deletion.removes("series", "2026-11-16T01:00:00Z"))
        assertTrue(deletion.removes("series", "2026-11-17T01:00:00Z"))
    }

    @Test fun `whole event deletion preserves other events`() {
        for (scope in listOf(null, "series")) {
            val deletion = ConfirmedEventDeletion("event", scope)
            assertTrue(deletion.removes("event", "2026-11-16T01:00:00Z"))
            assertFalse(deletion.removes("other", "2026-11-16T01:00:00Z"))
        }
    }

    @Test fun `unknown scope or invalid boundary never guesses which occurrences to remove`() {
        assertFalse(ConfirmedEventDeletion("event", "unknown").removes("event", "2026-11-16T01:00:00Z"))
        assertFalse(ConfirmedEventDeletion("event", "future", "invalid").removes("event", "2026-11-16T01:00:00Z"))
        assertFalse(ConfirmedEventDeletion("event", "instance").removes("event", "2026-11-16T01:00:00Z"))
    }
}
