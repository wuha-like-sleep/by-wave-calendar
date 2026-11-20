// 本地地址簿 —— 地点输入的联想来源。产品口径与网页 / 桌面 / Android
// 一致：地址只存本机，靠「用过」一点点攒起来。
//   - 首次使用时从账号已有事件的 location 播种（seed，只加不覆盖）；
//   - 每次保存带地点的事件就记一次使用（计数 + 最近使用时间）；
//   - 输入时按子串匹配，排序：开头命中 → 用得多 → 最近用。
// 在线兜底（/api/v1/geo/suggest）只是补充：本地命中太少时才查，选中
// 在线结果同样记一次使用写回本地——攒得越多，在线查得越少。
//
// 持久化走 UserDefaults（与本 APP 其它本机偏好同一路子）：条目以
// JSON 存 bwc.addressBook.v1，播种标记 bwc.addressBook.seeded.v1，
// 在线开关 bwc.geo.onlineSuggestions（默认开）。纯逻辑收在
// AddressBook 里，不碰存储，Tests 里可以直接打。

import Foundation

struct AddressEntry: Codable, Equatable {
    var address: String
    var useCount: Int
    var lastUsedAt: Int64 // epoch millis；播种来的条目是 0
}

/// 地址簿纯逻辑：与网页端 bwcAddressBook 同口径，改一处要想另一处。
enum AddressBook {

    static let maxEntries = 300

    /// 展示用归一化：去首尾空白、内部连续空白压成一个空格。
    static func normalize(_ value: String?) -> String {
        guard let value else { return "" }
        return value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// 匹配 / 去重用键：归一化后小写。
    static func key(_ value: String?) -> String {
        normalize(value).lowercased()
    }

    /// 记一次使用。已存在（按 key 认）→ 计数 +1、刷新时间，并采用
    /// 这次的写法作展示串；不存在 → 新增。总数封顶，淘汰最久没用的。
    static func upsert(_ entries: [AddressEntry], address: String, now: Int64) -> [AddressEntry] {
        let display = normalize(address)
        if display.isEmpty { return entries }
        let k = key(display)
        var out = entries
        if let idx = out.firstIndex(where: { key($0.address) == k }) {
            out[idx] = AddressEntry(address: display, useCount: out[idx].useCount + 1, lastUsedAt: now)
        } else {
            out.append(AddressEntry(address: display, useCount: 1, lastUsedAt: now))
        }
        if out.count > maxEntries {
            out.sort { $0.lastUsedAt < $1.lastUsedAt }
            out = Array(out.suffix(maxEntries))
        }
        return out
    }

    /// 播种：已有条目一个字都不动；新条目计数 = 在材料里出现几次，
    /// lastUsedAt = 0。同 key 多种写法时展示串取第一次出现的。
    static func seed(_ entries: [AddressEntry], locations: [String]) -> [AddressEntry] {
        let known = Set(entries.map { key($0.address) })
        var counts: [String: AddressEntry] = [:]
        var order: [String] = []
        for raw in locations {
            let display = normalize(raw)
            if display.isEmpty { continue }
            let k = key(display)
            if known.contains(k) { continue }
            if let prev = counts[k] {
                counts[k] = AddressEntry(address: prev.address, useCount: prev.useCount + 1, lastUsedAt: 0)
            } else {
                counts[k] = AddressEntry(address: display, useCount: 1, lastUsedAt: 0)
                order.append(k)
            }
        }
        var out = entries + order.compactMap { counts[$0] }
        if out.count > maxEntries {
            out.sort {
                if $0.useCount != $1.useCount { return $0.useCount > $1.useCount }
                return $0.lastUsedAt > $1.lastUsedAt
            }
            out = Array(out.prefix(maxEntries))
        }
        return out
    }

    /// 本地匹配：子串匹配；开头命中优先，其次用得多、最近用。
    /// 查询为空返回最常用的几条。
    static func match(_ entries: [AddressEntry], query: String, limit: Int = 5) -> [String] {
        let q = key(query)
        let matched = entries.filter { entry in
            !normalize(entry.address).isEmpty && (q.isEmpty || key(entry.address).contains(q))
        }
        let sorted = matched.sorted { a, b in
            if !q.isEmpty {
                let aHead = key(a.address).hasPrefix(q) ? 0 : 1
                let bHead = key(b.address).hasPrefix(q) ? 0 : 1
                if aHead != bHead { return aHead < bHead }
            }
            if a.useCount != b.useCount { return a.useCount > b.useCount }
            return a.lastUsedAt > b.lastUsedAt
        }
        return sorted.prefix(limit).map { $0.address }
    }
}

/// 地址簿的 UserDefaults 存储 + 播种标记 + 在线开关。
enum AddressBookStore {

    private static let entriesKey = "bwc.addressBook.v1"
    private static let seededKey = "bwc.addressBook.seeded.v1"
    private static let onlineKey = "bwc.geo.onlineSuggestions"

    static func entries() -> [AddressEntry] {
        guard let data = UserDefaults.standard.data(forKey: entriesKey),
              let decoded = try? JSONDecoder().decode([AddressEntry].self, from: data)
        else { return [] }
        return decoded
    }

    private static func persist(_ entries: [AddressEntry]) {
        if let data = try? JSONEncoder().encode(entries) {
            UserDefaults.standard.set(data, forKey: entriesKey)
        }
    }

    /// 保存事件 / 选中在线结果时记一次使用。
    static func recordUse(_ address: String) {
        if AddressBook.normalize(address).isEmpty { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        persist(AddressBook.upsert(entries(), address: address, now: now))
    }

    static func isSeeded() -> Bool {
        UserDefaults.standard.bool(forKey: seededKey)
    }

    static func seed(locations: [String]) {
        if isSeeded() { return }
        persist(AddressBook.seed(entries(), locations: locations))
        UserDefaults.standard.set(true, forKey: seededKey)
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
