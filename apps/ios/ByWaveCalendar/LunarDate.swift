// LunarDate.swift
// 农历（中国农历）显示串。Foundation 的 .chinese 日历直接给出
// 干支纪年序号（1–60）、农历月、日和闰月标记，配上名称表就能
// 拼出「丙午年十月廿一」，不需要自带万年历数据表。

import Foundation

enum LunarDate {
    private static let stems = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"]
    private static let branches = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"]
    private static let monthNames = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"]
    private static let dayNames = [
        "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
        "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
        "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
    ]

    private static var chineseCalendar: Calendar { Calendar(identifier: .chinese) }

    /// 廿一 / 初三 —— 日视图周条里每个日期下面的小字。
    static func dayName(for date: Date) -> String {
        let day = chineseCalendar.component(.day, from: date)
        return (1...30).contains(day) ? dayNames[day - 1] : ""
    }

    /// 丙午年十月廿一 —— 周条下面居中的整行（对着选中日）。
    static func fullDate(for date: Date) -> String {
        let c = chineseCalendar.dateComponents([.year, .month, .day, .isLeapMonth], from: date)
        guard let year = c.year, let month = c.month, let day = c.day,
              (1...60).contains(year), (1...12).contains(month), (1...30).contains(day)
        else { return "" }
        let yearName = stems[(year - 1) % 10] + branches[(year - 1) % 12] + "年"
        let monthName = (c.isLeapMonth == true ? "闰" : "") + monthNames[month - 1] + "月"
        return yearName + monthName + dayNames[day - 1]
    }
}
