import Foundation

// 本地地址簿纯逻辑（ByWaveCalendar/AddressBook.swift）：与网页端
// bwcAddressBook / 桌面 / Android 同口径——归一化、记使用、播种
// 只加不覆盖、匹配排序。用 precondition 断言，风格同本目录其它
// Check 文件。本机无 Xcode 工具链，未运行。
@main struct AddressBookCheck {
    static func main() {
        // normalize：连续空白压成一个空格
        precondition(AddressBook.normalize("  7  Kitchen   Rd ") == "7 Kitchen Rd")
        precondition(AddressBook.normalize(nil) == "")
        precondition(AddressBook.normalize("   ") == "")

        // upsert：新增计数 1；同 key（大小写/空白不同）计数 +1 并采用新写法
        precondition(
            AddressBook.upsert([], address: "A St", now: 100)
                == [AddressEntry(address: "A St", useCount: 1, lastUsedAt: 100)]
        )
        precondition(
            AddressBook.upsert([AddressEntry(address: "a  st", useCount: 2, lastUsedAt: 50)], address: "A St", now: 200)
                == [AddressEntry(address: "A St", useCount: 3, lastUsedAt: 200)]
        )
        precondition(AddressBook.upsert([], address: "  ", now: 1).isEmpty)

        // seed：已有条目不动；新条目计数 = 出现次数；同 key 展示串取第一次
        let seeded = AddressBook.seed(
            [AddressEntry(address: "Home", useCount: 7, lastUsedAt: 999)],
            locations: ["home", "Office", "Office"]
        )
        precondition(seeded.contains(AddressEntry(address: "Home", useCount: 7, lastUsedAt: 999)))
        precondition(seeded.contains(AddressEntry(address: "Office", useCount: 2, lastUsedAt: 0)))
        precondition(
            AddressBook.seed([], locations: ["X", "x"])
                == [AddressEntry(address: "X", useCount: 2, lastUsedAt: 0)]
        )

        // match：开头命中优先，其次用得多、最近用；空查询给最常用
        let entries = [
            AddressEntry(address: "Melbourne Central", useCount: 1, lastUsedAt: 10),
            AddressEntry(address: "Central Station, Sydney", useCount: 9, lastUsedAt: 20),
            AddressEntry(address: "Melbourne Zoo", useCount: 3, lastUsedAt: 30),
        ]
        precondition(AddressBook.match(entries, query: "central") == ["Central Station, Sydney", "Melbourne Central"])
        precondition(AddressBook.match(entries, query: "melbourne") == ["Melbourne Zoo", "Melbourne Central"])
        precondition(AddressBook.match(entries, query: "", limit: 2) == ["Central Station, Sydney", "Melbourne Zoo"])
        precondition(AddressBook.match(entries, query: "perth").isEmpty)

        print("AddressBookCheck OK")
    }
}
