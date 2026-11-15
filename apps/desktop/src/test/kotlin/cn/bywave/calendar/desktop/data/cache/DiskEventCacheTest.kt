package cn.bywave.calendar.desktop.data.cache

import cn.bywave.calendar.desktop.data.model.EventsResponse
import cn.bywave.calendar.desktop.data.model.CalendarMeta
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.*

class DiskEventCacheTest {
    private val response = EventsResponse(listOf(CalendarMeta("c", "Work", "#123456")), emptyList())
    private fun withRoot(test: (Path) -> Unit) {
        val root = Files.createTempDirectory("bywave-cache-test-")
        try { test(root) } finally { Files.walk(root).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) } }
    }
    @Test fun roundTripAndProfileIsolation() = withRoot { root ->
        val cache = DiskEventCache(root)
        cache.write("a/b", "from", "to", response)
        assertEquals(response, cache.read("a/b", "from", "to"))
        assertNull(cache.read("a_b", "from", "to"))
        cache.clear("a_b")
        assertEquals(response, cache.read("a/b", "from", "to"))
        cache.clear("a/b")
        assertNull(cache.read("a/b", "from", "to"))
    }
    @Test fun snapshotsExpireAndFutureTimestampsAreRejected() = withRoot { root ->
        var clock = 1_000_000L
        val cache = DiskEventCache(root, { clock })
        cache.write("p", "a", "b", response)
        clock += DiskEventCache.MAX_AGE_MS + 1
        assertNull(cache.read("p", "a", "b"))
        cache.write("p", "a", "b", response)
        clock -= 300_001
        assertNull(cache.read("p", "a", "b"))
    }
    @Test fun corruptSnapshotsAreCacheMisses() = withRoot { root ->
        val cache = DiskEventCache(root)
        cache.write("p", "a", "b", response)
        Files.walk(root).use { paths -> paths.filter(Files::isRegularFile).forEach { Files.writeString(it, "broken") } }
        assertNull(cache.read("p", "a", "b"))
    }
    @Test fun diskUsageIsBoundedAndClearCannotEscapeRoot() = withRoot { root ->
        val cache = DiskEventCache(root.resolve("cache"))
        val sentinel = root.resolve("keep.txt")
        Files.writeString(sentinel, "keep")
        (1..40).forEach { cache.write("p", "$it", "b", response) }
        val count = Files.walk(root.resolve("cache")).use { paths -> paths.filter(Files::isRegularFile).count() }
        assertEquals(32L, count)
        cache.clear("..")
        assertEquals("keep", Files.readString(sentinel))
    }
}
