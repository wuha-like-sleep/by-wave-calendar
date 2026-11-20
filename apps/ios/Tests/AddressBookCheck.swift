import Foundation

// 本地地址簿 v2 纯逻辑（ByWaveCalendar/AddressBook.swift）：与网页端
// bwcAddressBook / 桌面 / Android 同口径——规范化（缩写归一）、
// 记使用（来源/关键词）、播种、编辑学习、带打分的匹配（词元任意
// 序 / 模糊 / 拼音首字母 / 上下文）。用 precondition 断言，风格同
// 本目录其它 Check 文件。本机无 Xcode 工具链，未运行。
@main struct AddressBookCheck {
    static func mk(_ address: String, _ useCount: Int = 1, _ lastUsedAt: Int64 = 0, _ keywords: [String: Int] = [:]) -> AddressEntry {
        AddressEntry(
            address: address,
            normalized: AddressBook.canonicalize(address),
            useCount: useCount,
            lastUsedAt: lastUsedAt,
            firstSeenAt: lastUsedAt,
            source: "typed",
            keywords: keywords
        )
    }

    static func main() {
        // normalize / canonicalize：空白折叠 + 缩写变体归一
        precondition(AddressBook.normalize("  7  Kitchen   Rd ") == "7 Kitchen Rd")
        precondition(AddressBook.normalize(nil) == "")
        precondition(AddressBook.canonicalize("7 Kitchen Rd") == AddressBook.canonicalize("7 Kitchen Road"))
        precondition(AddressBook.canonicalize("  MELBOURNE  Central, ") == "melbourne central")
        precondition(AddressBook.canonicalize("1 Smith St.") == AddressBook.canonicalize("1 Smith Street"))

        // 拼音首字母（系统 transliteration）+ 编辑距离
        precondition(AddressBook.pinyinInitials("北京站") == "bjz")
        precondition(AddressBook.editDistance("melbourne", "melborne", maxDist: 2) == 1)
        precondition(AddressBook.editDistance("abc", "xyz", maxDist: 1) > 1)

        // upsert：计数、采用新写法、标题关键词学习
        var entries = AddressBook.upsert([], address: "7 Kitchen Rd", now: 1000, title: "BBQ night")
        precondition(entries.count == 1 && entries[0].keywords["bbq"] == 1)
        entries = AddressBook.upsert(entries, address: "7 Kitchen Road", now: 2000)
        precondition(entries.count == 1 && entries[0].useCount == 2 && entries[0].address == "7 Kitchen Road")

        // upsert（online）：组件/坐标落条目
        let geo = GeoSuggestion(
            label: "Melbourne Central", name: nil, street: "La Trobe Street",
            suburb: nil, city: "Melbourne", state: nil, postcode: nil,
            country: nil, lat: -37.8, lon: 144.9
        )
        let online = AddressBook.upsert([], address: "Melbourne Central", now: 1000, source: "online", geo: geo)
        precondition(online[0].source == "online" && online[0].street == "La Trobe Street" && online[0].lat == -37.8)

        // seed：已有条目不动；新条目计数 = 出现次数，source=seed
        let seeded = AddressBook.seed([mk("Home", 7, 999)], locations: ["home", "Office", "Office"], now: 5000)
        precondition(seeded.first { $0.address == "Home" }?.useCount == 7)
        precondition(seeded.first { $0.address == "Office" }?.useCount == 2)
        precondition(seeded.first { $0.address == "Office" }?.source == "seed")

        // 编辑学习：改得像 → 原条目改名保计数/首见；改得不像 → 两条
        let before = [mk("Melbourne Central", 3, 500)]
        let edited = AddressBook.learnFromSave(before, picked: "Melbourne Central", saved: "Melbourne Central, La Trobe Street", now: 9000)
        precondition(edited.count == 1 && edited[0].address == "Melbourne Central, La Trobe Street")
        precondition(edited[0].useCount == 4 && edited[0].firstSeenAt == 500)
        let split = AddressBook.learnFromSave(before, picked: "Melbourne Central", saved: "Sydney Opera House", now: 9000)
        precondition(split.count == 2)

        // 匹配：词元任意序 / 模糊 / 拼音 / 上下文加权 / 无关不命中
        let now: Int64 = 1_800_000_000_000
        let book = [
            mk("Melbourne Central", 1, 10),
            mk("Central Station, Sydney", 9, 20),
            mk("Melbourne Zoo", 3, 30),
            mk("北京站", 2, 40),
        ]
        precondition(AddressBook.match(book, query: "central melbourne", now: now).contains("Melbourne Central"))
        precondition(AddressBook.match(book, query: "melborne central", now: now).contains("Melbourne Central"))
        precondition(AddressBook.match(book, query: "bjz", now: now) == ["北京站"])
        precondition(AddressBook.match(book, query: "perth airport", now: now).isEmpty)

        let pair = [
            mk("Office Park", 2, 10, ["dentist": 4]),
            mk("Office Park North", 2, 10),
        ]
        precondition(AddressBook.match(pair, query: "office park", title: "Dentist appointment", now: now).first == "Office Park")

        print("AddressBookCheck: all passed")
    }
}
