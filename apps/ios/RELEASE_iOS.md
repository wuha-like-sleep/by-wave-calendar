# iOS 发布 runbook(App Store)

适用:ByWave Calendar iOS,bundle `cn.bywave.calendar`,Team `672677A7QM`(Runsen Zhao)。

## 0. 每次发版改哪里

`ByWaveCalendar.xcodeproj/project.pbxproj` 里两个键(Debug/Release 各一份,共 4 处,
Xcode 里改 TARGETS → General → Identity 会一起改):

- `MARKETING_VERSION` — 用户可见版本,如 1.6.1
- `CURRENT_PROJECT_VERSION` — build 号,**每次上传 App Store Connect 必须递增**,如 21

提交信息惯例:`iOS: 1.6.0 → 1.6.1 (build 21)`。

## 1. 构建前(iCloud 规避,本机必做)

```bash
rsync -a --delete --exclude .git ~/Desktop/by-wave-calendar/apps/ios/ ~/bywave-ios-build/ios/
find ~/bywave-ios-build/ios -name '* 2*' -delete
xattr -cr ~/bywave-ios-build/ios
```

## 2. Archive

两条路,选一条:

**A. Xcode GUI(推荐,签名最省心)**
```bash
open ~/bywave-ios-build/ios/ByWaveCalendar.xcodeproj
```
1. 顶部设备选 **Any iOS Device (arm64)**
2. Product → Archive
3. 弹出 Organizer → 选中刚出的 archive → **Distribute App → App Store Connect → Upload**
4. 全默认下一步。首次会提示创建 **Apple Distribution** 证书 —— 需要 Xcode →
   Settings → Accounts 里已登录 Apple ID(本机目前只有开发证书,这一步就是补分发证书)

**B. 命令行 archive(验证构建用;上传仍走 Organizer)**
```bash
cd ~/bywave-ios-build/ios
xcodebuild -project ByWaveCalendar.xcodeproj -scheme ByWaveCalendar \
  -destination 'generic/platform=iOS' -archivePath ~/bywave-ios-build/ByWaveCalendar.xcarchive \
  archive
open ~/bywave-ios-build/ByWaveCalendar.xcarchive   # 会进 Organizer,继续 Distribute
```

## 3. App Store Connect 一次性设置(首次发布)

https://appstoreconnect.apple.com → 我的 App → ➕ 新建 App:

- 平台 iOS,名称 **ByWave Calendar**(被占用就 ByWave 日历 / ByWave Calendar – 自托管日历)
- 主要语言 **简体中文**;Bundle ID 选 `cn.bywave.calendar`;SKU 随意(如 `bywave-calendar-ios`)
- 类别:效率(Productivity)
- 价格:免费

**App 隐私**(问卷答案要和代码里的 `PrivacyInfo.xcprivacy` 一致):

- 不追踪(NSPrivacyTracking = false,无第三方 SDK / 无广告 / 无分析)
- 数据收集:App 只把账号邮箱和日历数据发给**用户自己填写的自托管服务器**,
  开发者不运营强制的中心服务器、收不到这些数据 → 可选「不收集数据」;
  若审核质疑,改选「收集 → 邮箱+日历数据,关联身份,不用于追踪」并在备注说明自托管架构。
- 加密出口合规:Info.plist 已声明 `ITSAppUsesNonExemptEncryption = false`(只用系统 HTTPS),
  上传后不会再弹问卷。

**审核信息(必填,否则大概率被拒)**:

- 自托管应用,审核员没有服务器就登不进去。**必须提供演示环境**:
  - 演示服务器:`https://rl.lz-ss.com`(生产实例)
  - 在上面建一个演示账号(如 appreview@…,普通用户即可,里面放几条示例事件),
    账号密码填进「App 审核信息 → 登录信息」
- 备注栏建议写明(中英皆可):
  “This is a self-hosted calendar client. Users connect to their own server instance.
  A demo server + account is provided above. QR-pairing and password login both work
  against the demo server.”

**素材**:

- 截图:6.9" (iPhone 17 Pro Max / 16 Pro Max) 必传,6.5" 可复用;模拟器 ⌘S 直接出 PNG
- App 图标 1024 已内置资产目录,无需单独上传

## 4. 提交审核

1. 上传的 build 处理完(邮件通知,约 10–30 分钟)后,在 App Store Connect 选中该 build
2. 填「此版本的新增内容」
3. 提交审核。TestFlight 想先内测的话,build 处理完即可加内部测试员,无需审核

## 5. 已知审核风险与对策

- **Guideline 4.2 最低功能 / 2.1 需要登录**:对策就是上面的演示账号,别省。
- **账号删除要求(5.1.1(v))**:App 内已有「删除账号」(设置 → 账号 → 删除),满足要求。
- **推送能力**:entitlements 已不含 aps-environment(v1.3.3 有意移除),不会触发
  「声明了能力却不用」的质疑;将来启用照 `ByWaveCalendar.entitlements` 注释操作。

## 6. 发完之后

- 打 tag:`git tag ios-v1.6.1 && git push origin ios-v1.6.1`(区别于服务端的 vX.Y.Z tag)
- 把 App Store 链接挂到 web 端设置页 / 官网
