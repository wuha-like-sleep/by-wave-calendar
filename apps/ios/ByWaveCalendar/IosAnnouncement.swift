// 服务端下发的 iOS 应用内公告（GET /api/app/ios/announcement）。
//
// iOS 没有自更新：新版只在 App Store 里，App 自己不知道。所以「商店里
// 有新版」由服务端喊一嗓子 —— 管理员在后台发布一条公告（版本 / 标题 /
// 正文 / 商店链接），客户端启动时来拉。设置页的「应用更新」是用户主动
// 查（走商店 lookup），这条是服务端主动推，两个入口互补。
//
// 展示规则都在客户端这边（接口是公开无鉴权的，服务端不知道问的人在
// 跑什么版本）：
//  - 公告版本不比本机版本新 → 不展示（已经在新版上的人不该被喊去更新）。
//  - 关掉过就不再弹：去重键是「版本 + 发布时间」。管理员改了内容再
//    保存一次，发布时间会变，于是能再弹一次 —— 这是后台那边的既定
//    口径，别把去重简化成只看版本，否则「改文案重发」永远发不出去。

import Foundation

struct IosAnnouncement: Decodable, Equatable {
    let version: String
    let title: String
    let body: String
    let storeUrl: String
    let publishedAt: String

    /// 商店链接：公告里带了就用公告的，没带就用内置的应用商店地址
    /// （与 AppUpdateView 里那个是同一个）。
    var effectiveStoreURL: URL {
        if let url = URL(string: storeUrl), url.scheme == "https" { return url }
        return URL(string: "https://apps.apple.com/app/id6772655143")!
    }

    private static let dismissedKey = "bwc.announcement.dismissed"
    private var dismissalStamp: String { "\(version)@\(publishedAt)" }

    var isDismissed: Bool {
        UserDefaults.standard.string(forKey: Self.dismissedKey) == dismissalStamp
    }

    func markDismissed() {
        UserDefaults.standard.set(dismissalStamp, forKey: Self.dismissedKey)
    }

    /// 该不该现在展示：比本机新、且这一版（这一轮发布）没被关掉过。
    var shouldShow: Bool {
        version.compare(PairingService.appVersion, options: .numeric) == .orderedDescending
            && !isDismissed
    }
}
