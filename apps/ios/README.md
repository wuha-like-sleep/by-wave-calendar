# ByWave Calendar — iOS 原生 APP（v0.1 起步包）

完整可跑的 Xcode 项目。**双击 `ByWaveCalendar.xcodeproj` → ⌘R 就跑**。

当前功能：
- 输入服务器地址 OR 扫码登录（来自 Web 的 `/app/settings#devices`）
- Keychain 持久化 refresh token
- 访问令牌自动刷新（401 透明重试）
- 列出今天 + 接下来 7 天的事件（只读）
- 启动 splash + pull-to-refresh + 退出登录

后续会补：
- 事件创建 / 编辑 / 删除 + 重复事件三选项
- 月/周视图（自绘 SwiftUI）
- APNs 推送通知
- Sign in with Apple
- 离线缓存（Core Data）
- RSVP 邀请

## 怎么跑

```bash
cd ~/Desktop/by-wave-calendar/apps/ios
open ByWaveCalendar.xcodeproj
```

打开 Xcode 后：

1. **左上选签名**：左侧导航点项目蓝图标 → TARGETS → ByWaveCalendar → **Signing & Capabilities** → "Team" 下拉选你的 Apple Developer 账号
   - Bundle Identifier 默认是 `cn.bywave.calendar`，可能跟别人冲突。先改成你自己的，比如 `com.你名字.bywave-calendar`
2. **选目标设备**：顶部模拟器选 iPhone 15 / 你的 iPhone
3. **⌘R 跑**
4. APP 启动 → 「服务器地址」屏幕：
   - 输入 `https://calendar.example.com`
   - 或点「扫码登录」→ 用相机对准网页 `/app/settings#devices` → 「绑定新设备」弹出来的 QR
5. 成功登录 → 看到今天 + 接下来 7 天的事件列表

## 真机本地调试

iOS 默认不允许 http 明文流量。如果你的服务器跑在 `http://192.168.x.x:3000`，需要给项目加 ATS 例外。

在 Xcode 里：
- 左侧导航点 ByWaveCalendar 蓝图标 → TARGETS → Info（这是 Info plist 编辑器）
- 加 Key: **App Transport Security Settings**
- 展开 → 加 sub key **Allow Arbitrary Loads in Local Networking** = YES

生产 https 不需要这一段。

## 项目架构

```
ByWaveCalendar/
├── ByWaveCalendarApp.swift   # @main 入口
├── AppState.swift            # 全局状态 / 自动 token 刷新
├── Network/
│   ├── APIClient.swift       # URLSession 封装，自动 Bearer + 401 重试
│   └── Models.swift          # EventDTO / CalendarMeta
├── Auth/
│   ├── Keychain.swift        # refresh token 存 iOS Keychain
│   └── PairingService.swift  # 扫码后调 /devices/pair-claim
└── Views/
    ├── RootView.swift        # 路由 SetupView / CalendarView
    ├── SetupView.swift       # 服务器地址 + 扫码按钮
    ├── ScannerView.swift     # AVFoundation 自绘 QR 扫描
    └── CalendarView.swift    # 今天 + 7 天事件列表
```

主要类的职责：

- **AppState** (`@MainActor ObservableObject`)：全局状态 — 服务器 URL / refresh token / access token / current user
- **APIClient**：URLSession 封装，自动给请求加 `Authorization: Bearer ...`，401 自动调 refresh，成功后重发原请求
- **Keychain**：refresh token 存 iOS Keychain（设备解锁后可读）
- **PairingService**：调 `/api/v1/devices/pair-claim` 把扫到的 code 换成 token
- **RootView**：根据 AppState 分流到 SetupView 或 CalendarView，含启动 splash
- **SetupView**：服务器地址输入 + 扫码按钮
- **ScannerView**：`AVCaptureSession` 扫 QR
- **CalendarView**：调 `/api/v1/events?from=...&to=...` 显示当天的事件列表

## 项目设置（已经预置好了）

- **iOS 最低**：16.0（要 NavigationStack + async/await）
- **Bundle ID**：`cn.bywave.calendar`（**记得改成你自己的**）
- **Display Name**：ByWaveCalendar
- **Marketing Version**：0.1.0
- **相机权限文案**：「扫描二维码登录需要使用相机」(已在 build settings 里)
- **支持横竖屏**：iPhone 竖屏 + 左右横屏；iPad 全部方向
- **Swift**：5.0
- **Deployment Target**：iOS 16

## 下一步迭代

按这个顺序加（每个迭代独立可发布）：

1. 事件详情视图（点列表项进详情）
2. 新建 / 编辑事件（重复事件三选项 - 复用 web 端 UI 思路）
3. 周视图 / 月视图
4. Pull-to-refresh + 后台 fetch
5. APNs 推送（需要 Server 改一下 push 发送让 device 走 APNs 而不是 Web Push）
6. Core Data 离线缓存
7. RSVP 邀请处理
8. Sign in with Apple（先得把 server 端的 Apple SSO 写出来）
9. Widget（今日事件 small/medium widget）
10. Apple Watch 配套

## 常见错误

**「Could not find the developer disk image」**
- 你的 iPhone iOS 版本比 Xcode 新。升级 Xcode（App Store）解决。

**「The provided account does not have access to "..."」**
- Bundle Identifier 跟别的开发者的撞了。改成你自己的（建议格式 `com.姓名首字母.bywave-calendar`）。

**编译报错 "Cannot find 'NavigationStack' in scope"**
- 你不小心把 Deployment Target 改到 < iOS 16 了。改回去。

**扫码闪退 / 黑屏**
- 没给相机权限。设置 → 隐私 → 相机 → ByWaveCalendar 打开。
- 或者真机调试时第一次没弹权限询问 —— 删 APP 重装。
