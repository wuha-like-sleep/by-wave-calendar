# ByWave Calendar — iOS 原生 APP

当前版本:**1.6.1 (build 21)**,iOS 16.0+,SwiftUI + Swift Concurrency。
与 web 端同账号同数据:手机建的事件 web 立刻可见,反之亦然(同一套 `/api/v1` 接口)。

## 功能现状

- **登录**:扫码配对 / 邮箱密码(含 MFA 两步验证)/ 配对码 / Sign in with Apple(服务器配好 `SIWA_CLIENT_IDS` 后,见 `SIGN_IN_WITH_APPLE_SETUP.md`)
- **多账号**:Google 式 profile 切换器,每个账号独立 Keychain 令牌与事件缓存
- **视图**:日 / 周 / 月 / 年
- **事件**:创建 / 编辑 / 删除;重复事件三选项(仅此次 / 此后所有 / 整个系列);参与人邀请;入会密码一键复制
- **搜索**、**预约链接**(Calendly 式)管理
- **系统集成**:EventKit 镜像到 iOS 日历、本地通知提醒、离线事件缓存
- **本地化**:8 种语言 100% 覆盖(简中 / 繁中 / 英 / 日 / 韩 / 西 / 法 / 德),日期格式跟随语言
- 深浅色主题 + 服务器下发主题色;法律页内嵌(隐私 / 条款 / 数据处理)

## 怎么跑

```bash
cd ~/Desktop/by-wave-calendar/apps/ios
open ByWaveCalendar.xcodeproj
```

选模拟器 → ⌘R。启动后在登录页输入服务器地址(或扫 web 端「设置 → 我的设备 → 绑定新设备」的二维码)。

### ⚠️ 本机构建注意:iCloud 目录会弄坏 CodeSign

`~/Desktop` 是 iCloud 同步目录,同步加的 xattr / FinderInfo 会导致 CodeSign 随机失败,
iCloud 还会生成 `文件 2.swift` 这类重复文件破坏编译。命令行构建先 rsync 出去:

```bash
rsync -a --delete --exclude .git ~/Desktop/by-wave-calendar/apps/ios/ ~/bywave-ios-build/ios/
find ~/bywave-ios-build/ios -name '* 2*' -delete
xattr -cr ~/bywave-ios-build/ios
cd ~/bywave-ios-build/ios && xcodebuild -project ByWaveCalendar.xcodeproj -scheme ByWaveCalendar \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath ~/bywave-ios-build/dd build
```

Xcode GUI 里直接开桌面上的工程通常没事,但遇到莫名 CodeSign / 编译错误,先想到 iCloud。

### 真机连本地 http 服务器

iOS 默认禁明文 http(127.0.0.1 除外)。服务器在 `http://192.168.x.x:3000` 时需要临时加 ATS
例外(TARGETS → Info → App Transport Security Settings → Allow Arbitrary Loads in Local
Networking = YES)。**发布版不要带这个例外。**

## 架构速览

```
ByWaveCalendar/
├── ByWaveCalendarApp.swift    # @main
├── AppState.swift             # 多账号全局状态 + 令牌静默刷新
├── Profile.swift              # 一个账号 = 一个 Profile(服务器 + 邮箱)
├── Network/
│   ├── APIClient.swift        # URLSession 封装:Bearer + 401 重试 + envelope 兼容
│   └── Models.swift           # DTO
├── Auth/                      # Keychain / 扫码配对 / Apple 登录 / 网页登录
├── Sync/                      # EventKit 镜像 / 事件缓存 / 本地通知 / 推送(占位)
├── Views/                     # 日周月年、事件编辑、参与人、搜索、预约链接、设置…
└── *.lproj/                   # 8 语言 Localizable.strings
```

关键设计,改代码前先知道:

- **令牌**:refresh token 存 Keychain(按 profile 隔离),access token 只在内存;
  服务器时间戳带毫秒(`.000Z`),解析必须 `.withFractionalSeconds`(v1.3.4 血泪教训,
  丢了它用户每小时被登出一次)。
- **幂等创建**:POST /events 带 `clientUid`(compose 时生成、重试复用),服务器按
  `(calendarId, uid)` 去重——网络重试不会「一个事件变三份」。
- **响应格式**:`/api/v1` 大部分路由包 `{ok, data}` envelope,少数(events 等)裸返回;
  `APIClient.request` 先尝试剥 envelope 再裸解,两种都吃。
- **删除**:DELETE /events/:id 永远 204(服务器故意的),不要按 404 分支写逻辑。
- **推送**:APNs 能力在 v1.3.3 有意移除(服务器还没发 APNs),`PushService` 留桩;
  重新启用的完整清单在 `ByWaveCalendar.entitlements` 注释里。

## 发布

见 [RELEASE_iOS.md](RELEASE_iOS.md)(版本号位置、archive 命令、App Store Connect 步骤)。

## 常见错误

**CodeSign 莫名失败 / 出现 `xxx 2.swift`** — iCloud,见上面。
**「The provided account does not have access to …”」** — Bundle ID 撞了别人的,改成自己的。
**扫码黑屏** — 相机权限没给:设置 → 隐私 → 相机;真机首次没弹询问就删 APP 重装。
**每小时被登出** — 检查 `parseIsoLenient` 是否被改坏(必须容忍毫秒)。
