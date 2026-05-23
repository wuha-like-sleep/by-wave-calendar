# ByWave Calendar — iOS 原生 APP（v0.1 起步包）

这是一个可直接放到 Xcode 跑的 SwiftUI 起步包。当前能跑的：
- 输入服务器地址 OR 扫码登录（来自 Web 的 `/app/settings#devices`）
- Keychain 持久化 refresh token
- 访问令牌自动刷新
- 列出今天的事件（只读）

后续会补：
- 事件创建 / 编辑 / 删除
- 月/周视图（自绘 SwiftUI）
- APNs 推送通知
- Sign in with Apple
- 离线缓存 + Core Data
- RSVP 邀请

## 在 Xcode 里把它跑起来

### 1. 新建 Xcode 项目

1. Xcode → File → New → Project → iOS → **App**
2. Product Name: `ByWaveCalendar`
3. Interface: **SwiftUI**
4. Language: **Swift**
5. Storage: **None**（自己用 Keychain，不用 Core Data）
6. **Include Tests**: ✓
7. 把项目存到任意位置（不一定在这个 monorepo 里）

### 2. 把这些源文件加进去

把下面这些文件**整段拷贝**到 Xcode 项目里（替换默认的 `ContentView.swift` 和 `ByWaveCalendarApp.swift`，并新建对应的文件夹组）：

```
ByWaveCalendar/
├── ByWaveCalendarApp.swift          ← 替换 Xcode 默认的
├── AppState.swift                   ← 新建
├── Network/
│   ├── APIClient.swift              ← 新建
│   └── Models.swift                 ← 新建
├── Auth/
│   ├── Keychain.swift               ← 新建
│   └── PairingService.swift         ← 新建
└── Views/
    ├── RootView.swift               ← 新建
    ├── SetupView.swift              ← 新建
    ├── ScannerView.swift            ← 新建
    └── CalendarView.swift           ← 新建（替换默认 ContentView）
```

在 Xcode 里：
1. 右键项目根 → **New Group** → 起名 `Network`、`Auth`、`Views`
2. 每个 Group 上右键 → **New File** → **Swift File** → 用上面的文件名
3. 粘贴本仓库 `apps/ios/ByWaveCalendar/<group>/<file>.swift` 的内容

### 3. 配置权限（相机扫码用）

打开 `Info` 标签（Xcode 14+ 里项目的 Info 是 plist 编辑器）：
- 加 Key: **Privacy - Camera Usage Description**
- Value: `扫码登录需要使用相机`

### 4. Target 设置

- **Minimum Deployments**: iOS 16.0（用了 `NavigationStack`、`async/await`）
- **Bundle Identifier**: 任意，比如 `cn.lz-ss.bywave-calendar`
- 用你 Apple Developer 账号的 Team 签名

### 5. 跑

- Xcode 顶部选 iPhone 模拟器（or 真机）
- ⌘R 跑
- App 启动 → 「服务器地址」屏 → 输入 `https://rl.lz-ss.com`（或本地开发用 `http://你的电脑IP:3000`）→「连接」
- 或者点「扫码登录」，去 Web 端 `/app/settings#devices` → 「绑定新设备」 → 扫弹出的 QR

### 真机本地调试小贴士

iOS 默认不允许 http 明文流量。开发时如果你的服务器跑在 `http://192.168.x.x:3000`，需要在 Info.plist 加：

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
```

生产环境用 https 就不用这一段。

## 项目架构速览

- **AppState** (`@MainActor ObservableObject`)：全局状态 — 服务器 URL / refresh token / access token / current user
- **APIClient**：URLSession 封装，自动给请求加 `Authorization: Bearer ...`，401 自动调 refresh，成功后重发原请求
- **Keychain**：refresh token 存到 iOS Keychain（设备解锁后可读）
- **PairingService**：调 `/api/v1/devices/pair-claim` 把扫到的 code 换成 token
- **RootView**：根据 AppState 分流到 SetupView 或 CalendarView
- **SetupView**：服务器地址输入 + 扫码按钮
- **ScannerView**：`AVCaptureSession` 扫 QR
- **CalendarView**：调 `/api/v1/events?from=...&to=...` 显示当天的事件列表

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
