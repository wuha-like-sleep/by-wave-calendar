// 本地地址簿 —— 地点输入的联想来源。产品口径与网页 / 桌面端一致：
// 地址只存本机，靠「用过」一点点攒起来。
//   - 首次使用时从本机 Room 缓存里已有事件的 location 播种
//     （seed，只加不覆盖）；
//   - 每次保存带地点的事件就记一次使用（计数 + 最近使用时间）；
//   - 输入时按子串匹配，排序：开头命中 → 用得多 → 最近用。
// 在线兜底（/api/v1/geo/suggest）只是补充：本地命中太少时才查，选中
// 在线结果同样记一次使用写回本地——攒得越多，在线查得越少。
//
// 持久化：filesDir/address-book.tsv，每行 lastUsedAt \t useCount \t
// address。地址先经 normalize（连续空白压成一个空格），不会带进
// Tab / 换行，TSV 安全。纯逻辑收在 AddressBook 对象里，不碰文件与
// Context，JVM 单测可以直接打。

package cn.bywave.calendar.data.store

import android.content.Context
import java.io.File

data class AddressEntry(
    val address: String,
    val useCount: Int,
    val lastUsedAt: Long,
)

/** 地址簿纯逻辑：与网页端 bwcAddressBook / 桌面端同口径。 */
object AddressBook {

    const val MAX_ENTRIES = 300

    /** 展示用归一化：去首尾空白、内部连续空白压成一个空格。 */
    fun normalize(value: String?): String =
        (value ?: "").trim().replace(Regex("\\s+"), " ")

    /** 匹配 / 去重用键：归一化后小写。 */
    fun key(value: String?): String = normalize(value).lowercase()

    /** 记一次使用：已存在 → 计数 +1 并采用新写法；不存在 → 新增。
     *  总数封顶，超了淘汰最久没用的。 */
    fun upsert(entries: List<AddressEntry>, address: String, now: Long): List<AddressEntry> {
        val display = normalize(address)
        if (display.isEmpty()) return entries.toList()
        val k = key(display)
        val idx = entries.indexOfFirst { key(it.address) == k }
        val out = entries.toMutableList()
        if (idx >= 0) {
            val prev = out[idx]
            out[idx] = AddressEntry(display, prev.useCount + 1, now)
        } else {
            out.add(AddressEntry(display, 1, now))
        }
        if (out.size > MAX_ENTRIES) {
            return out.sortedBy { it.lastUsedAt }.takeLast(MAX_ENTRIES)
        }
        return out
    }

    /** 播种：已有条目不动；新条目计数 = 出现次数，lastUsedAt = 0；
     *  同 key 多种写法时展示串取第一次出现的。 */
    fun seed(entries: List<AddressEntry>, locations: List<String>): List<AddressEntry> {
        val known = entries.map { key(it.address) }.toMutableSet()
        val counts = LinkedHashMap<String, AddressEntry>()
        for (raw in locations) {
            val display = normalize(raw)
            if (display.isEmpty()) continue
            val k = key(display)
            if (k in known) continue
            val prev = counts[k]
            counts[k] = AddressEntry(prev?.address ?: display, (prev?.useCount ?: 0) + 1, 0L)
        }
        val out = entries + counts.values
        if (out.size > MAX_ENTRIES) {
            return out.sortedWith(
                compareByDescending<AddressEntry> { it.useCount }.thenByDescending { it.lastUsedAt },
            ).take(MAX_ENTRIES)
        }
        return out
    }

    /** 本地匹配：子串匹配；开头命中优先，其次用得多、最近用。
     *  查询为空返回最常用的几条。 */
    fun match(entries: List<AddressEntry>, query: String, limit: Int = 5): List<String> {
        val q = key(query)
        val matched = entries
            .filter { normalize(it.address).isNotEmpty() }
            .filter { q.isEmpty() || key(it.address).contains(q) }
        return matched.sortedWith(
            compareBy<AddressEntry> { if (q.isNotEmpty() && !key(it.address).startsWith(q)) 1 else 0 }
                .thenByDescending { it.useCount }
                .thenByDescending { it.lastUsedAt },
        ).take(limit).map { it.address }
    }
}

/** 地址簿的文件存储 + 播种标记。读写失败一律静默退化成空簿。 */
class AddressBookStore(context: Context) {

    private val storeFile = File(context.filesDir, "address-book.tsv")
    private val seededFile = File(context.filesDir, "address-book.seeded")

    private var cache: List<AddressEntry>? = null

    @Synchronized
    fun entries(): List<AddressEntry> {
        cache?.let { return it }
        val loaded = runCatching {
            if (!storeFile.exists()) {
                emptyList()
            } else {
                storeFile.readLines().mapNotNull { line ->
                    val parts = line.split("\t", limit = 3)
                    if (parts.size < 3) {
                        null
                    } else {
                        val address = AddressBook.normalize(parts[2])
                        if (address.isEmpty()) {
                            null
                        } else {
                            AddressEntry(
                                address = address,
                                useCount = parts[1].toIntOrNull() ?: 1,
                                lastUsedAt = parts[0].toLongOrNull() ?: 0L,
                            )
                        }
                    }
                }
            }
        }.getOrDefault(emptyList())
        cache = loaded
        return loaded
    }

    @Synchronized
    private fun persist(entries: List<AddressEntry>) {
        cache = entries
        runCatching {
            storeFile.writeText(
                entries.joinToString("\n") { "${it.lastUsedAt}\t${it.useCount}\t${it.address}" },
            )
        }
    }

    /** 保存事件 / 选中在线结果时记一次使用。 */
    @Synchronized
    fun recordUse(address: String) {
        if (AddressBook.normalize(address).isEmpty()) return
        persist(AddressBook.upsert(entries(), address, System.currentTimeMillis()))
    }

    fun isSeeded(): Boolean = runCatching { seededFile.exists() }.getOrDefault(false)

    /** 首次播种：材料由调用方提供（Room 缓存里的已有地点）。 */
    @Synchronized
    fun seed(locations: List<String>) {
        if (isSeeded()) return
        persist(AddressBook.seed(entries(), locations))
        runCatching { seededFile.writeText("1") }
    }
}
