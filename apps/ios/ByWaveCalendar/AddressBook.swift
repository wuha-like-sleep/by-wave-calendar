// 本地地址簿 —— 地点输入的联想来源。产品口径与网页 / 桌面 / Android
// 一致：地址只存本机，靠「用过」一点点攒起来。条目是结构化的：
//   address 展示串 / normalized 规范键 / useCount / lastUsedAt /
//   firstSeenAt / source(seed|typed|online) / 在线组件与坐标 /
//   keywords（标题关键词 → 次数，用标题上下文加权排序）。
// 规范化：小写、去标点、缩写展开（Rd→road 等），变体写法归一条。
// 学习三路：保存记使用、选中又改了再保存走「编辑学习」改原条目、
// 在线结果选中即以 online 来源 + 组件入库。
// 匹配：整串包含 > 词元全命中（任意序）> 部分命中；词元认前缀 /
// 小编辑距离 / 拼音首字母。拼音走系统 transliteration
// （StringTransform.toLatin），覆盖全部汉字——另外三端受限于打包
// 的常用字表，这是 iOS 的平台优势，不引第三方依赖。
// 在线兜底（/api/v1/geo/suggest）只是补充：本地命中太少时才查。
//
// 持久化：Application Support/ByWaveCalendar/address-book.json
// 结构化文档（{seeded, entries}，原子写）。本 APP 没有 CoreData /
// SwiftData / SQLite 层，结构化数据一贯是 Codable 文件，为 ≤300
// 条引数据库不成比例——取舍在此注明。v1 的 UserDefaults 数据首次
// 读取时迁移进来并清掉旧键。在线开关仍是 UserDefaults 偏好
// （bwc.geo.onlineSuggestions，默认开）。纯逻辑收在 AddressBook
// 里，不碰存储，Tests 里可以直接打。

import Foundation

struct AddressEntry: Codable, Equatable {
    var address: String
    var normalized: String = ""
    var useCount: Int = 1
    var lastUsedAt: Int64 = 0 // epoch millis；播种来的条目是 0
    var firstSeenAt: Int64 = 0
    var source: String = "typed" // seed | typed | online
    var street: String? = nil
    var suburb: String? = nil
    var city: String? = nil
    var state: String? = nil
    var postcode: String? = nil
    var country: String? = nil
    var lat: Double? = nil
    var lon: Double? = nil
    var keywords: [String: Int] = [:]
}

/// 地址簿纯逻辑：与网页端 bwcAddressBook 同口径，改一处要想另一处。
enum AddressBook {

    static let maxEntries = 300
    private static let maxKeywords = 12

    private static let abbrev: [String: String] = [
        "rd": "road", "st": "street", "ave": "avenue", "av": "avenue",
        "blvd": "boulevard", "dr": "drive", "ln": "lane", "ct": "court",
        "pl": "place", "hwy": "highway", "fwy": "freeway", "stn": "station",
        "ctr": "centre", "cntr": "centre", "apt": "apartment", "ste": "suite",
        "n": "north", "s": "south", "e": "east", "w": "west",
        "ne": "northeast", "nw": "northwest", "se": "southeast", "sw": "southwest",
        "mt": "mount", "univ": "university",
    ]

    /// 展示用归一化：去首尾空白、内部连续空白压成一个空格。
    static func normalize(_ value: String?) -> String {
        guard let value else { return "" }
        return value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// 规范键：小写、标点变空格、缩写展开。
    static func canonicalize(_ value: String?) -> String {
        let lowered = normalize(value).lowercased()
        let spaced = lowered.unicodeScalars.map { scalar -> Character in
            CharacterSet.punctuationCharacters.contains(scalar) ? " " : Character(scalar)
        }
        return String(spaced)
            .split(whereSeparator: { $0.isWhitespace })
            .map { abbrev[String($0)] ?? String($0) }
            .joined(separator: " ")
    }

    static func tokensOf(_ canonical: String) -> [String] {
        canonical.split(separator: " ").map(String.init)
    }

    /// 有界 Levenshtein：超过 maxDist 直接返回 maxDist+1。
    static func editDistance(_ a: String, _ b: String, maxDist: Int) -> Int {
        let xs = Array(a)
        let ys = Array(b)
        if abs(xs.count - ys.count) > maxDist { return maxDist + 1 }
        var prev = Array(0...ys.count)
        for i in 1..<(xs.count + 1) {
            var cur = [Int](repeating: 0, count: ys.count + 1)
            cur[0] = i
            var rowMin = i
            for j in 1..<(ys.count + 1) {
                let cost = xs[i - 1] == ys[j - 1] ? 0 : 1
                cur[j] = min(min(prev[j] + 1, cur[j - 1] + 1), prev[j - 1] + cost)
                rowMin = min(rowMin, cur[j])
            }
            if rowMin > maxDist { return maxDist + 1 }
            prev = cur
        }
        return prev[ys.count]
    }

    /// 中文词元的拼音首字母串（系统 transliteration 全量覆盖）；
    /// 没有汉字或转写失败返回空串。
    static func pinyinInitials(_ token: String) -> String {
        guard token.unicodeScalars.contains(where: { $0.value >= 0x4E00 && $0.value <= 0x9FFF }) else {
            return ""
        }
        guard let latin = token.applyingTransform(.toLatin, reverse: false),
              let plain = latin.applyingTransform(.stripDiacritics, reverse: false)
        else { return "" }
        var out = ""
        for word in plain.lowercased().split(whereSeparator: { !$0.isLetter }) {
            if let first = word.first { out.append(first) }
        }
        return out
    }

    private static let stopwords: Set<String> = ["the", "a", "an", "and", "with", "to", "of", "at", "in", "on"]

    /// 从事件标题抽关键词：英文词（≥2 字符，去停用词）+ 汉字二元组。
    static func titleKeywords(_ title: String?) -> [String] {
        var out: [String] = []
        var seen = Set<String>()
        func push(_ kw: String) {
            if !kw.isEmpty && !stopwords.contains(kw) && seen.insert(kw).inserted {
                out.append(kw)
            }
        }
        let text = (title ?? "").lowercased()
        var current = ""
        func flush() {
            if current.isEmpty { return }
            let word = current
            current = ""
            if word.unicodeScalars.allSatisfy({ $0.value >= 0x4E00 && $0.value <= 0x9FFF }) {
                let chars = Array(word)
                if chars.count == 1 { push(word) }
                if chars.count >= 2 {
                    for i in 0...(chars.count - 2) {
                        push(String(chars[i...(i + 1)]))
                    }
                }
            } else if word.count >= 2 {
                push(word)
            }
        }
        for ch in text {
            if ch.isLetter || ch.isNumber {
                current.append(ch)
            } else {
                flush()
            }
        }
        flush()
        return Array(out.prefix(6))
    }

    private static func mergeKeywords(_ existing: [String: Int], title: String?) -> [String: Int] {
        guard let title, !title.isEmpty else { return existing }
        var kw = existing
        for k in titleKeywords(title) { kw[k, default: 0] += 1 }
        let sorted = kw.sorted { $0.value > $1.value }
        return Dictionary(uniqueKeysWithValues: sorted.prefix(maxKeywords).map { ($0.key, $0.value) })
    }

    private static func fillComponents(_ entry: AddressEntry, geo: GeoSuggestion?) -> AddressEntry {
        guard let geo else { return entry }
        var out = entry
        if out.street == nil { out.street = geo.street }
        if out.suburb == nil { out.suburb = geo.suburb }
        if out.city == nil { out.city = geo.city }
        if out.state == nil { out.state = geo.state }
        if out.postcode == nil { out.postcode = geo.postcode }
        if out.country == nil { out.country = geo.country }
        if out.lat == nil { out.lat = geo.lat }
        if out.lon == nil { out.lon = geo.lon }
        return out
    }

    private static func asGeo(_ e: AddressEntry) -> GeoSuggestion {
        GeoSuggestion(
            label: e.address, name: nil, street: e.street, suburb: e.suburb,
            city: e.city, state: e.state, postcode: e.postcode,
            country: e.country, lat: e.lat, lon: e.lon
        )
    }

    /// 卫生处理：近重复合并（同门牌 + 词元 Jaccard ≥ 0.85）+ 按价值封顶。
    static func hygiene(_ entries: [AddressEntry]) -> [AddressEntry] {
        var list = entries.filter { !normalize($0.address).isEmpty && !$0.normalized.isEmpty }
        var used = [Bool](repeating: false, count: list.count)
        var merged: [AddressEntry] = []
        for i in list.indices {
            if used[i] { continue }
            var acc = list[i]
            let aToks = Set(tokensOf(acc.normalized))
            for j in (i + 1)..<list.count {
                if used[j] { continue }
                let b = list[j]
                let bToks = Set(tokensOf(b.normalized))
                let numA = aToks.first(where: { $0.allSatisfy { $0.isNumber } }) ?? ""
                let numB = bToks.first(where: { $0.allSatisfy { $0.isNumber } }) ?? ""
                if numA != numB { continue }
                let inter = aToks.intersection(bToks).count
                let union = aToks.union(bToks).count
                if union > 0 && Double(inter) / Double(union) >= 0.85 {
                    let keep = acc.useCount >= b.useCount ? acc : b
                    let drop = keep.normalized == acc.normalized && keep.address == acc.address ? b : acc
                    var kw: [String: Int] = [:]
                    for k in Set(keep.keywords.keys).union(drop.keywords.keys) {
                        kw[k] = (keep.keywords[k] ?? 0) + (drop.keywords[k] ?? 0)
                    }
                    let kwTrimmed = Dictionary(
                        uniqueKeysWithValues: kw.sorted { $0.value > $1.value }
                            .prefix(maxKeywords).map { ($0.key, $0.value) }
                    )
                    var next = keep
                    next.useCount = acc.useCount + b.useCount
                    next.lastUsedAt = max(acc.lastUsedAt, b.lastUsedAt)
                    next.firstSeenAt = min(acc.firstSeenAt, b.firstSeenAt)
                    next.keywords = kwTrimmed
                    acc = fillComponents(next, geo: asGeo(drop))
                    used[j] = true
                }
            }
            merged.append(acc)
        }
        list = merged
        if list.count > maxEntries {
            list.sort {
                if $0.useCount != $1.useCount { return $0.useCount > $1.useCount }
                return $0.lastUsedAt > $1.lastUsedAt
            }
            list = Array(list.prefix(maxEntries))
        }
        return list
    }

    /// 记一次使用（保存成功 / 在线选中）。
    static func upsert(
        _ entries: [AddressEntry],
        address: String,
        now: Int64,
        source: String = "typed",
        title: String? = nil,
        geo: GeoSuggestion? = nil
    ) -> [AddressEntry] {
        let display = normalize(address)
        if display.isEmpty { return hygiene(entries) }
        let key = canonicalize(display)
        var list = entries
        if let idx = list.firstIndex(where: { $0.normalized == key }) {
            var next = list[idx]
            next.address = display
            next.useCount += 1
            next.lastUsedAt = now
            next.keywords = mergeKeywords(next.keywords, title: title)
            list[idx] = fillComponents(next, geo: geo)
        } else {
            let fresh = AddressEntry(
                address: display, normalized: key, useCount: 1,
                lastUsedAt: now, firstSeenAt: now, source: source,
                keywords: mergeKeywords([:], title: title)
            )
            list.append(fillComponents(fresh, geo: geo))
        }
        return hygiene(list)
    }

    /// 播种：已有条目不动；新条目 source=seed、计数 = 出现次数。
    static func seed(_ entries: [AddressEntry], locations: [String], now: Int64) -> [AddressEntry] {
        let known = Set(entries.map { $0.normalized })
        var counts: [String: AddressEntry] = [:]
        var order: [String] = []
        for raw in locations {
            let display = normalize(raw)
            if display.isEmpty { continue }
            let k = canonicalize(display)
            if known.contains(k) { continue }
            if var prev = counts[k] {
                prev.useCount += 1
                counts[k] = prev
            } else {
                counts[k] = AddressEntry(
                    address: display, normalized: k, useCount: 1,
                    lastUsedAt: 0, firstSeenAt: now, source: "seed"
                )
                order.append(k)
            }
        }
        return hygiene(entries + order.compactMap { counts[$0] })
    }

    /// 两个地址「足够像」：包含 / 词元 Jaccard ≥ 0.5 / 编辑距离相对小。
    static func similar(_ a: String, _ b: String) -> Bool {
        let ka = canonicalize(a)
        let kb = canonicalize(b)
        if ka.isEmpty || kb.isEmpty { return false }
        if ka == kb { return true }
        if ka.contains(kb) || kb.contains(ka) { return true }
        let aT = Set(tokensOf(ka))
        let bT = Set(tokensOf(kb))
        let union = aT.union(bT).count
        if union > 0 && Double(aT.intersection(bT).count) / Double(union) >= 0.5 { return true }
        let maxLen = max(ka.count, kb.count)
        let budget = max(2, maxLen / 4)
        return editDistance(ka, kb, maxDist: budget) <= budget
    }

    /// 编辑学习：选中建议 picked 又改了、以 saved 保存。足够像 → 把
    /// picked 那条原地改成 saved（saved 另有一条则合并）；不像 →
    /// 当新地址正常记一次。
    static func learnFromSave(
        _ entries: [AddressEntry],
        picked: String?,
        saved: String,
        now: Int64,
        title: String? = nil
    ) -> [AddressEntry] {
        let display = normalize(saved)
        if display.isEmpty { return entries }
        guard let picked,
              canonicalize(picked) != canonicalize(display),
              similar(picked, display)
        else {
            return upsert(entries, address: display, now: now, title: title)
        }
        var list = entries
        guard let pIdx = list.firstIndex(where: { $0.normalized == canonicalize(picked) }) else {
            return upsert(entries, address: display, now: now, title: title)
        }
        var base = list[pIdx]
        if let sIdx = list.indices.first(where: { $0 != pIdx && list[$0].normalized == canonicalize(display) }) {
            let other = list[sIdx]
            base.useCount += other.useCount
            base.firstSeenAt = min(base.firstSeenAt, other.firstSeenAt)
            base.keywords = other.keywords
            base = fillComponents(base, geo: asGeo(other))
            list.remove(at: max(pIdx, sIdx))
            list.remove(at: min(pIdx, sIdx))
        } else {
            list.remove(at: pIdx)
        }
        base.address = display
        base.normalized = canonicalize(display)
        base.useCount += 1
        base.lastUsedAt = now
        base.keywords = mergeKeywords(base.keywords, title: title)
        list.append(base)
        return hygiene(list)
    }

    private static func tokenMatches(_ qTok: String, _ eTok: String) -> Bool {
        if qTok == eTok { return true }
        if eTok.hasPrefix(qTok) { return true }
        if qTok.count > eTok.count && qTok.hasPrefix(eTok) { return true }
        if qTok.allSatisfy({ $0.isNumber }) || eTok.allSatisfy({ $0.isNumber }) { return false }
        if qTok.count >= 4 && eTok.count >= 4 {
            let maxD = max(qTok.count, eTok.count) >= 7 ? 2 : 1
            if editDistance(qTok, eTok, maxDist: maxD) <= maxD { return true }
        }
        if qTok.allSatisfy({ $0.isLetter && $0.isASCII }) &&
            eTok.unicodeScalars.contains(where: { $0.value >= 0x4E00 && $0.value <= 0x9FFF }) {
            let ini = pinyinInitials(eTok)
            if !ini.isEmpty && ini.hasPrefix(qTok) { return true }
        }
        return false
    }

    /// 带打分的本地匹配（与网页端同口径）：匹配质量 + 次数 + 新近 +
    /// 标题上下文。返回展示串列表。
    static func match(
        _ entries: [AddressEntry],
        query: String,
        title: String? = nil,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        limit: Int = 5
    ) -> [String] {
        let qCanon = canonicalize(query)
        let qToks = tokensOf(qCanon)
        let ctx = titleKeywords(title)
        var scored: [(address: String, score: Double, lastUsedAt: Int64)] = []
        for e in entries {
            if normalize(e.address).isEmpty { continue }
            var base = 0.0
            if qCanon.isEmpty {
                base = 50
            } else if e.normalized == qCanon {
                base = 110
            } else if e.normalized.contains(qCanon) {
                base = 100
            } else if !qToks.isEmpty {
                let eToks = tokensOf(e.normalized)
                var matched = 0
                var lastPos = -1
                var inOrder = true
                for qt in qToks {
                    if let pos = eToks.firstIndex(where: { tokenMatches(qt, $0) }) {
                        matched += 1
                        if pos < lastPos { inOrder = false }
                        lastPos = max(lastPos, pos)
                    }
                }
                if matched == qToks.count {
                    base = inOrder ? 85 : 75
                } else if matched >= (qToks.count + 1) / 2 {
                    base = 55 * Double(matched) / Double(qToks.count)
                }
            }
            if base <= 0 { continue }
            let freq = Double(min(e.useCount, 25)) * 1.2
            let days = max(0.0, Double(now - e.lastUsedAt) / 86400000.0)
            let recency = max(0.0, 12 * (1 - days / 90))
            var context = 0.0
            for k in ctx { context += Double(min(e.keywords[k] ?? 0, 5)) * 3 }
            context = min(context, 30)
            scored.append((e.address, base + freq + recency + context, e.lastUsedAt))
        }
        scored.sort {
            if $0.score != $1.score { return $0.score > $1.score }
            return $0.lastUsedAt > $1.lastUsedAt
        }
        return scored.prefix(limit).map { $0.address }
    }
}

/// 地址簿的结构化文档存储（Application Support 下 JSON，原子写）
/// + v1 UserDefaults 一次性迁移 + 在线开关（仍走 UserDefaults）。
enum AddressBookStore {

    private struct BookFile: Codable {
        var seeded: Bool
        var entries: [AddressEntry]
    }

    /// v1 条目形状，只用于迁移解码。
    private struct LegacyEntry: Codable {
        var address: String
        var useCount: Int
        var lastUsedAt: Int64
    }

    private static let legacyEntriesKey = "bwc.addressBook.v1"
    private static let legacySeededKey = "bwc.addressBook.seeded.v1"
    private static let onlineKey = "bwc.geo.onlineSuggestions"

    private static var fileURL: URL? {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        let folder = dir.appendingPathComponent("ByWaveCalendar", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent("address-book.json")
    }

    private static func load() -> BookFile {
        if let url = fileURL,
           let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode(BookFile.self, from: data) {
            return decoded
        }
        // v1 迁移：UserDefaults 里的旧簿 → v2 条目，标记一并带过来。
        var migrated: [AddressEntry] = []
        if let data = UserDefaults.standard.data(forKey: legacyEntriesKey),
           let legacy = try? JSONDecoder().decode([LegacyEntry].self, from: data) {
            migrated = legacy.map {
                AddressEntry(
                    address: $0.address,
                    normalized: AddressBook.canonicalize($0.address),
                    useCount: $0.useCount,
                    lastUsedAt: $0.lastUsedAt,
                    firstSeenAt: $0.lastUsedAt,
                    source: "typed"
                )
            }
        }
        let book = BookFile(
            seeded: UserDefaults.standard.bool(forKey: legacySeededKey),
            entries: migrated
        )
        if !migrated.isEmpty || UserDefaults.standard.bool(forKey: legacySeededKey) {
            persist(book)
            UserDefaults.standard.removeObject(forKey: legacyEntriesKey)
            UserDefaults.standard.removeObject(forKey: legacySeededKey)
        }
        return book
    }

    private static func persist(_ book: BookFile) {
        guard let url = fileURL,
              let data = try? JSONEncoder().encode(book)
        else { return }
        try? data.write(to: url, options: [.atomic])
    }

    static func entries() -> [AddressEntry] {
        load().entries
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    /// 保存事件时学习（编辑学习 / 记使用二合一）。
    static func learnFromSave(picked: String?, saved: String, title: String?) {
        if AddressBook.normalize(saved).isEmpty { return }
        var book = load()
        book.entries = AddressBook.learnFromSave(book.entries, picked: picked, saved: saved, now: nowMs(), title: title)
        persist(book)
    }

    /// 选中在线结果：连组件一起以 online 来源学入。
    static func learnOnline(_ suggestion: GeoSuggestion) {
        var book = load()
        book.entries = AddressBook.upsert(
            book.entries, address: suggestion.label, now: nowMs(),
            source: "online", geo: suggestion
        )
        persist(book)
    }

    static func isSeeded() -> Bool {
        load().seeded
    }

    static func seed(locations: [String]) {
        var book = load()
        if book.seeded { return }
        book.entries = AddressBook.seed(book.entries, locations: locations, now: nowMs())
        book.seeded = true
        persist(book)
    }

    /// 「在线地址建议」开关（默认开）。关掉后不再发任何在线查询。
    static func onlineEnabled() -> Bool {
        if UserDefaults.standard.object(forKey: onlineKey) == nil { return true }
        return UserDefaults.standard.bool(forKey: onlineKey)
    }

    static func setOnlineEnabled(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: onlineKey)
    }
}
