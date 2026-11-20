// 本地地址簿 —— 地点输入的联想来源。产品口径与网页 / 桌面端一致：
// 地址只存本机，靠「用过」一点点攒起来。条目是结构化的：
//   address 展示串 / normalized 规范键 / useCount / lastUsedAt /
//   firstSeenAt / source(seed|typed|online) / 在线组件与坐标 /
//   keywords（标题关键词 → 次数，用标题上下文加权排序）。
// 规范化：小写、去标点、缩写展开（Rd→road 等），变体写法归一条。
// 学习三路：保存记使用、选中又改了再保存走「编辑学习」改原条目、
// 在线结果选中即以 online 来源 + 组件入库。
// 匹配：整串包含 > 词元全命中（任意序）> 部分命中；词元认前缀 /
// 小编辑距离 / 拼音首字母（常用字表）。排序 = 匹配质量 + 次数 +
// 新近 + 标题上下文。
//
// 存储：Room（AppDatabase 的 address_entries 表，主键 = 规范键）——
// 平台标准本地数据库。运行时以内存缓存为准（同步读），变更后整表
// 回写。旧版 filesDir TSV 首次加载时迁移进 Room 并删除。
// 纯逻辑在 AddressBook 对象里，不碰 Context / 数据库，JVM 单测
// 可以直接打。

package cn.bywave.calendar.data.store

import android.content.Context
import cn.bywave.calendar.data.model.GeoSuggestion
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

data class AddressEntry(
    val address: String,
    val normalized: String,
    val useCount: Int,
    val lastUsedAt: Long,
    val firstSeenAt: Long,
    val source: String,
    val street: String? = null,
    val suburb: String? = null,
    val city: String? = null,
    val state: String? = null,
    val postcode: String? = null,
    val country: String? = null,
    val lat: Double? = null,
    val lon: Double? = null,
    val keywords: Map<String, Int> = emptyMap(),
)

/** 地址簿纯逻辑：与网页端 bwcAddressBook 同口径，改一处要想另一处。 */
object AddressBook {

    const val MAX_ENTRIES = 300
    private const val MAX_KEYWORDS = 12

    private val ABBREV = mapOf(
        "rd" to "road", "st" to "street", "ave" to "avenue", "av" to "avenue",
        "blvd" to "boulevard", "dr" to "drive", "ln" to "lane", "ct" to "court",
        "pl" to "place", "hwy" to "highway", "fwy" to "freeway", "stn" to "station",
        "ctr" to "centre", "cntr" to "centre", "apt" to "apartment", "ste" to "suite",
        "n" to "north", "s" to "south", "e" to "east", "w" to "west",
        "ne" to "northeast", "nw" to "northwest", "se" to "southeast", "sw" to "southwest",
        "mt" to "mount", "univ" to "university",
    )

    // 拼音首字母表（常用地名/地址/姓氏字）——与网页/桌面端同一张表。
    // iOS 端用系统 transliteration 覆盖全量，不依赖此表。
    private val PINYIN_INITIALS: Map<Char, Char> = buildMap {
        val groups = mapOf(
            'a' to "阿安爱奥澳",
            'b' to "北百本白滨宝保八办步",
            'c' to "长城重川村场厂超朝车陈蔡曹崔程昌春成",
            'd' to "大东道学单街德定点店都",
            'e' to "二恩",
            'f' to "方福丰法飞凤府房发",
            'g' to "广国高工公馆港贵桂甘古光",
            'h' to "海河湖汉华黄杭后和合花红号会行",
            'j' to "江家金建街机京九嘉济局景江",
            'k' to "开科昆康口",
            'l' to "路老刘李林梁罗卢吕陆廖黎雷龙乐立里",
            'm' to "马门民明贸南",
            'n' to "南宁昌通阳内农",
            'p' to "平潘彭浦",
            'q' to "青清桥七区千秋桥",
            'r' to "人日仁瑞荣",
            's' to "上山水三四苏深石狮商厦市省",
            't' to "天太津台一铁同",
            'w' to "王吴汪万五无锡无文武",
            'x' to "西新小徐薛夏华兴心向",
            'y' to "杨余姚叶袁云一阳阳",
            'z' to "张郑周朱赵邹中正中山镇中州中站",
        )
        for ((initial, chars) in groups) for (ch in chars) putIfAbsent(ch, initial)
    }

    private val PUNCT = Regex("[.,，、;；:：'’‘\"“”()（）·\\-]")

    /** 展示用归一化：去首尾空白、内部连续空白压成一个空格。 */
    fun normalize(value: String?): String =
        (value ?: "").trim().replace(Regex("\\s+"), " ")

    /** 规范键：小写、标点变空格、缩写展开。 */
    fun canonicalize(value: String?): String =
        normalize(value).lowercase().replace(PUNCT, " ")
            .split(Regex("\\s+")).filter { it.isNotEmpty() }
            .joinToString(" ") { ABBREV[it] ?: it }

    fun tokensOf(canonical: String): List<String> =
        if (canonical.isEmpty()) emptyList() else canonical.split(" ").filter { it.isNotEmpty() }

    /** 有界 Levenshtein：超过 maxDist 直接返回 maxDist+1。 */
    fun editDistance(a: String, b: String, maxDist: Int): Int {
        if (abs(a.length - b.length) > maxDist) return maxDist + 1
        var prev = IntArray(b.length + 1) { it }
        for (i in 1..a.length) {
            val cur = IntArray(b.length + 1)
            cur[0] = i
            var rowMin = i
            for (j in 1..b.length) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                cur[j] = min(min(prev[j] + 1, cur[j - 1] + 1), prev[j - 1] + cost)
                if (cur[j] < rowMin) rowMin = cur[j]
            }
            if (rowMin > maxDist) return maxDist + 1
            prev = cur
        }
        return prev[b.length]
    }

    /** 中文词元的拼音首字母串；有查不到的汉字就整体放弃（返回空）。 */
    fun pinyinInitials(token: String): String {
        val sb = StringBuilder()
        for (ch in token) {
            val ini = PINYIN_INITIALS[ch]
            when {
                ini != null -> sb.append(ini)
                ch in 'a'..'z' || ch in '0'..'9' -> sb.append(ch)
                ch in '\u4e00'..'\u9fff' -> return ""
                else -> Unit
            }
        }
        return sb.toString()
    }

    private val STOPWORDS = setOf("the", "a", "an", "and", "with", "to", "of", "at", "in", "on")

    /** 从事件标题抽关键词：英文词（≥2 字符，去停用词）+ 汉字二元组。 */
    fun titleKeywords(title: String?): List<String> {
        val out = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        fun push(kw: String) {
            if (kw.isNotEmpty() && kw !in STOPWORDS && seen.add(kw)) out.add(kw)
        }
        val text = (title ?: "").lowercase()
        for (word in text.split(Regex("[^\\p{L}\\p{N}]+"))) {
            if (word.isEmpty()) continue
            if (word.all { it in '\u4e00'..'\u9fff' }) {
                if (word.length == 1) push(word)
                for (i in 0..word.length - 2) push(word.substring(i, i + 2))
            } else if (word.length >= 2) {
                push(word)
            }
        }
        return out.take(6)
    }

    private fun mergeKeywords(existing: Map<String, Int>, title: String?): Map<String, Int> {
        if (title.isNullOrEmpty()) return existing
        val kw = existing.toMutableMap()
        for (k in titleKeywords(title)) kw[k] = (kw[k] ?: 0) + 1
        return kw.entries.sortedByDescending { it.value }.take(MAX_KEYWORDS).associate { it.key to it.value }
    }

    private fun fillComponents(entry: AddressEntry, geo: GeoSuggestion?): AddressEntry {
        if (geo == null) return entry
        return entry.copy(
            street = entry.street ?: geo.street,
            suburb = entry.suburb ?: geo.suburb,
            city = entry.city ?: geo.city,
            state = entry.state ?: geo.state,
            postcode = entry.postcode ?: geo.postcode,
            country = entry.country ?: geo.country,
            lat = entry.lat ?: geo.lat,
            lon = entry.lon ?: geo.lon,
        )
    }

    private fun asGeo(e: AddressEntry): GeoSuggestion = GeoSuggestion(
        label = e.address, street = e.street, suburb = e.suburb, city = e.city,
        state = e.state, postcode = e.postcode, country = e.country, lat = e.lat, lon = e.lon,
    )

    /** 卫生处理：近重复合并（同门牌 + 词元 Jaccard ≥ 0.85）+ 按价值封顶。 */
    fun hygiene(entries: List<AddressEntry>): List<AddressEntry> {
        var list = entries.filter { normalize(it.address).isNotEmpty() && it.normalized.isNotEmpty() }
        val used = BooleanArray(list.size)
        val merged = mutableListOf<AddressEntry>()
        for (i in list.indices) {
            if (used[i]) continue
            var acc = list[i]
            val aToks = tokensOf(acc.normalized).toSet()
            for (j in i + 1 until list.size) {
                if (used[j]) continue
                val b = list[j]
                val bToks = tokensOf(b.normalized).toSet()
                val numA = aToks.firstOrNull { it.all { c -> c.isDigit() } } ?: ""
                val numB = bToks.firstOrNull { it.all { c -> c.isDigit() } } ?: ""
                if (numA != numB) continue
                val inter = aToks.intersect(bToks).size
                val union = (aToks + bToks).size
                if (union > 0 && inter.toDouble() / union >= 0.85) {
                    val keep = if (acc.useCount >= b.useCount) acc else b
                    val drop = if (keep === acc) b else acc
                    val kw = (keep.keywords.keys + drop.keywords.keys).associateWith {
                        (keep.keywords[it] ?: 0) + (drop.keywords[it] ?: 0)
                    }.entries.sortedByDescending { it.value }.take(MAX_KEYWORDS).associate { it.key to it.value }
                    acc = fillComponents(
                        keep.copy(
                            useCount = acc.useCount + b.useCount,
                            lastUsedAt = max(acc.lastUsedAt, b.lastUsedAt),
                            firstSeenAt = min(acc.firstSeenAt, b.firstSeenAt),
                            keywords = kw,
                        ),
                        asGeo(drop),
                    )
                    used[j] = true
                }
            }
            merged.add(acc)
        }
        list = merged
        if (list.size > MAX_ENTRIES) {
            list = list.sortedWith(
                compareByDescending<AddressEntry> { it.useCount }.thenByDescending { it.lastUsedAt },
            ).take(MAX_ENTRIES)
        }
        return list
    }

    /** 记一次使用（保存成功 / 在线选中）。 */
    fun upsert(
        entries: List<AddressEntry>,
        address: String,
        now: Long,
        source: String = "typed",
        title: String? = null,
        geo: GeoSuggestion? = null,
    ): List<AddressEntry> {
        val display = normalize(address)
        if (display.isEmpty()) return hygiene(entries)
        val key = canonicalize(display)
        val list = entries.toMutableList()
        val idx = list.indexOfFirst { it.normalized == key }
        if (idx >= 0) {
            val prev = list[idx]
            list[idx] = fillComponents(
                prev.copy(
                    address = display,
                    useCount = prev.useCount + 1,
                    lastUsedAt = now,
                    keywords = mergeKeywords(prev.keywords, title),
                ),
                geo,
            )
        } else {
            list.add(
                fillComponents(
                    AddressEntry(
                        address = display, normalized = key, useCount = 1,
                        lastUsedAt = now, firstSeenAt = now, source = source,
                        keywords = mergeKeywords(emptyMap(), title),
                    ),
                    geo,
                ),
            )
        }
        return hygiene(list)
    }

    /** 播种：已有条目不动；新条目 source=seed、计数 = 出现次数。 */
    fun seed(entries: List<AddressEntry>, locations: List<String>, now: Long): List<AddressEntry> {
        val known = entries.map { it.normalized }.toMutableSet()
        val counts = LinkedHashMap<String, AddressEntry>()
        for (raw in locations) {
            val display = normalize(raw)
            if (display.isEmpty()) continue
            val k = canonicalize(display)
            if (k in known) continue
            val prev = counts[k]
            counts[k] = if (prev != null) {
                prev.copy(useCount = prev.useCount + 1)
            } else {
                AddressEntry(display, k, 1, 0L, now, "seed")
            }
        }
        return hygiene(entries + counts.values)
    }

    /** 两个地址「足够像」：包含 / 词元 Jaccard ≥ 0.5 / 编辑距离相对小。 */
    fun similar(a: String, b: String): Boolean {
        val ka = canonicalize(a)
        val kb = canonicalize(b)
        if (ka.isEmpty() || kb.isEmpty()) return false
        if (ka == kb) return true
        if (ka.contains(kb) || kb.contains(ka)) return true
        val aT = tokensOf(ka).toSet()
        val bT = tokensOf(kb).toSet()
        val union = (aT + bT).size
        if (union > 0 && aT.intersect(bT).size.toDouble() / union >= 0.5) return true
        val maxLen = max(ka.length, kb.length)
        val budget = max(2, maxLen / 4)
        return editDistance(ka, kb, budget) <= budget
    }

    /** 编辑学习：选中建议 picked 又改了、以 saved 保存。足够像 → 把
     *  picked 那条原地改成 saved（saved 另有一条则合并）；不像 →
     *  当新地址正常记一次。 */
    fun learnFromSave(
        entries: List<AddressEntry>,
        picked: String?,
        saved: String,
        now: Long,
        title: String? = null,
    ): List<AddressEntry> {
        val display = normalize(saved)
        if (display.isEmpty()) return entries.toList()
        if (picked == null || canonicalize(picked) == canonicalize(display) || !similar(picked, display)) {
            return upsert(entries, display, now, "typed", title)
        }
        val list = entries.toMutableList()
        val pIdx = list.indexOfFirst { it.normalized == canonicalize(picked) }
        if (pIdx < 0) return upsert(entries, display, now, "typed", title)
        var base = list[pIdx]
        val sIdx = list.indices.firstOrNull { it != pIdx && list[it].normalized == canonicalize(display) }
        if (sIdx != null) {
            val other = list[sIdx]
            base = fillComponents(
                base.copy(
                    useCount = base.useCount + other.useCount,
                    firstSeenAt = min(base.firstSeenAt, other.firstSeenAt),
                    keywords = other.keywords,
                ),
                asGeo(other),
            )
            list.removeAt(max(pIdx, sIdx))
            list.removeAt(min(pIdx, sIdx))
        } else {
            list.removeAt(pIdx)
        }
        list.add(
            base.copy(
                address = display,
                normalized = canonicalize(display),
                useCount = base.useCount + 1,
                lastUsedAt = now,
                keywords = mergeKeywords(base.keywords, title),
            ),
        )
        return hygiene(list)
    }

    private fun tokenMatches(qTok: String, eTok: String): Boolean {
        if (qTok == eTok) return true
        if (eTok.startsWith(qTok)) return true
        if (qTok.length > eTok.length && qTok.startsWith(eTok)) return true
        if (qTok.all { it.isDigit() } || eTok.all { it.isDigit() }) return false
        if (qTok.length >= 4 && eTok.length >= 4) {
            val maxD = if (max(qTok.length, eTok.length) >= 7) 2 else 1
            if (editDistance(qTok, eTok, maxD) <= maxD) return true
        }
        if (qTok.all { it in 'a'..'z' } && eTok.any { it in '\u4e00'..'\u9fff' }) {
            val ini = pinyinInitials(eTok)
            if (ini.isNotEmpty() && ini.startsWith(qTok)) return true
        }
        return false
    }

    /** 带打分的本地匹配（与网页端同口径）：匹配质量 + 次数 + 新近 +
     *  标题上下文。返回展示串列表。 */
    fun match(
        entries: List<AddressEntry>,
        query: String,
        title: String? = null,
        now: Long = System.currentTimeMillis(),
        limit: Int = 5,
    ): List<String> {
        val qCanon = canonicalize(query)
        val qToks = tokensOf(qCanon)
        val ctx = titleKeywords(title)
        data class Scored(val address: String, val score: Double, val lastUsedAt: Long)
        val scored = mutableListOf<Scored>()
        for (e in entries) {
            if (normalize(e.address).isEmpty()) continue
            var base = 0.0
            when {
                qCanon.isEmpty() -> base = 50.0
                e.normalized == qCanon -> base = 110.0
                e.normalized.contains(qCanon) -> base = 100.0
                qToks.isNotEmpty() -> {
                    val eToks = tokensOf(e.normalized)
                    var matched = 0
                    var lastPos = -1
                    var inOrder = true
                    for (qt in qToks) {
                        val pos = eToks.indexOfFirst { tokenMatches(qt, it) }
                        if (pos >= 0) {
                            matched++
                            if (pos < lastPos) inOrder = false
                            lastPos = max(lastPos, pos)
                        }
                    }
                    base = when {
                        matched == qToks.size -> if (inOrder) 85.0 else 75.0
                        matched >= (qToks.size + 1) / 2 -> 55.0 * matched / qToks.size
                        else -> 0.0
                    }
                }
            }
            if (base <= 0) continue
            val freq = min(e.useCount, 25) * 1.2
            val days = max(0.0, (now - e.lastUsedAt) / 86400000.0)
            val recency = max(0.0, 12 * (1 - days / 90))
            var context = 0.0
            for (k in ctx) context += min(e.keywords[k] ?: 0, 5) * 3.0
            context = min(context, 30.0)
            scored.add(Scored(e.address, base + freq + recency + context, e.lastUsedAt))
        }
        return scored
            .sortedWith(compareByDescending<Scored> { it.score }.thenByDescending { it.lastUsedAt })
            .take(limit)
            .map { it.address }
    }
}

/** 地址簿的 Room 存储 + 播种标记（标记仍放 filesDir 小文件，与簿
 *  本体无关）。读写失败一律静默退化。 */
class AddressBookStore(context: Context) {

    private val appContext = context.applicationContext
    private val dao: AddressDao by lazy { AppDatabase.get(appContext).addressDao() }
    private val seededFile = File(appContext.filesDir, "address-book.seeded")
    private val legacyTsv = File(appContext.filesDir, "address-book.tsv")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true }

    @Volatile
    private var cache: List<AddressEntry>? = null

    /** 首次使用前把 Room 里的簿读进内存（含旧 TSV 一次性迁移）。 */
    suspend fun ensureLoaded() {
        if (cache != null) return
        val rows = runCatching { dao.listAll() }.getOrDefault(emptyList())
        var entries = rows.map { it.toEntry() }
        if (entries.isEmpty() && legacyTsv.exists()) {
            val legacy = runCatching {
                legacyTsv.readLines().mapNotNull { line ->
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
                                normalized = AddressBook.canonicalize(address),
                                useCount = parts[1].toIntOrNull() ?: 1,
                                lastUsedAt = parts[0].toLongOrNull() ?: 0L,
                                firstSeenAt = parts[0].toLongOrNull() ?: 0L,
                                source = "typed",
                            )
                        }
                    }
                }
            }.getOrDefault(emptyList())
            if (legacy.isNotEmpty()) {
                entries = legacy
                persist(legacy)
                runCatching { legacyTsv.delete() }
            }
        }
        cache = entries
    }

    fun entries(): List<AddressEntry> = cache ?: emptyList()

    private fun persist(entries: List<AddressEntry>) {
        cache = entries
        scope.launch {
            runCatching { dao.replaceAll(entries.map { it.toEntity() }) }
        }
    }

    @Synchronized
    fun recordUse(address: String, title: String? = null) {
        if (AddressBook.normalize(address).isEmpty()) return
        persist(AddressBook.upsert(entries(), address, System.currentTimeMillis(), "typed", title))
    }

    @Synchronized
    fun learnFromSave(picked: String?, saved: String, title: String? = null) {
        if (AddressBook.normalize(saved).isEmpty()) return
        persist(AddressBook.learnFromSave(entries(), picked, saved, System.currentTimeMillis(), title))
    }

    @Synchronized
    fun learnOnline(suggestion: GeoSuggestion) {
        persist(AddressBook.upsert(entries(), suggestion.label, System.currentTimeMillis(), "online", null, suggestion))
    }

    fun isSeeded(): Boolean = runCatching { seededFile.exists() }.getOrDefault(false)

    @Synchronized
    fun seed(locations: List<String>) {
        if (isSeeded()) return
        persist(AddressBook.seed(entries(), locations, System.currentTimeMillis()))
        runCatching { seededFile.writeText("1") }
    }

    private fun AddressEntry.toEntity(): AddressEntryEntity = AddressEntryEntity(
        normalized = normalized,
        address = address,
        useCount = useCount,
        lastUsedAt = lastUsedAt,
        firstSeenAt = firstSeenAt,
        source = source,
        street = street, suburb = suburb, city = city, state = state,
        postcode = postcode, country = country, lat = lat, lon = lon,
        keywordsJson = buildString {
            append("{")
            append(keywords.entries.joinToString(",") { (k, v) ->
                "\"${k.replace("\\", "\\\\").replace("\"", "\\\"")}\":$v"
            })
            append("}")
        },
    )

    private fun AddressEntryEntity.toEntry(): AddressEntry {
        val kw: Map<String, Int> = runCatching {
            val obj = json.parseToJsonElement(keywordsJson).jsonObject
            obj.entries.associate { (k, v) -> k to (v.jsonPrimitive.intOrNull ?: 0) }
        }.getOrDefault(emptyMap())
        return AddressEntry(
            address = address, normalized = normalized, useCount = useCount,
            lastUsedAt = lastUsedAt, firstSeenAt = firstSeenAt, source = source,
            street = street, suburb = suburb, city = city, state = state,
            postcode = postcode, country = country, lat = lat, lon = lon,
            keywords = kw,
        )
    }
}
