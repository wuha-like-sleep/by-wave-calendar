# ByWave Calendar — Desktop (macOS / Windows / Linux)

Compose Multiplatform Desktop 桌面端。Mac DMG + Win MSI + Linux DEB
一份 Kotlin 代码出三平台原生 app（Skia 渲染，不是 WebView 套壳）。

## 分发策略 — 仅 rl.lz-ss.com 自托管

本桌面端**不**上架 GitHub Releases / Gitee Releases。原因：
`SetupScreen.kt` 把默认服务器地址硬编码为 `https://rl.lz-ss.com`，
意味着这个二进制是 rl.lz-ss.com 专属构建，公开发布到第三方平台会
误导用户以为它能连任意自建服务器。

分发流程：

1. 在 macOS / Windows 各跑一次 `./gradlew packageDmg` / `packageMsi`，
   产物在 `build/compose/binaries/main/{dmg,msi}/`
2. 把产物（连同 SHA256）上传到生产服务器 `data/desktop-binaries/`
3. 编辑 `apps/desktop/releases/latest.json`（manifest 见下），
   `git commit && git push && pm2 reload`
4. 用户从 https://rl.lz-ss.com/download 下载，APP 内更新走
   `/api/app/desktop/latest`

如果以后想做完全开源的「自带服务器地址」版本，把 SetupScreen 的
硬编码默认改成空串（或开发期默认），再考虑公开发布。

## 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| v0.1 | 项目脚手架 + brand splash 窗口 + 跳浏览器按钮 + DMG/MSI 打包配置 | ✅ |
| v0.2 | 扫码登录 + 网络层 (Ktor) + ProfileStore 持久化 | ✅ 当前 |
| v0.3 | 日/周/月视图（复用 Android Compose 逻辑）+ Bearer 拦截器 | 待 |
| v0.4 | 事件 CRUD + 邀请人 | 待 |
| v0.5 | 多账号 + 设置页 | 待 |
| v0.6 | 系统日历镜像（macOS EventKit + Win Outlook COM）| 待 |
| v1.0 | 对齐 iOS / Android 全部功能 + 自动更新（轮询 /api/app/desktop/latest）| 目标 |

## 构建 & 调试

### 一次性环境

- **JDK 21 with `jpackage`**
  Android Studio bundled JBR 没带 jpackage（JetBrains 精简版），
  打 DMG/MSI 那步会失败。装完整 JDK 21：
  ```bash
  brew install --cask temurin@21
  # 或
  brew install --cask zulu@21
  ```
  装完 set 一下：
  ```bash
  export JAVA_HOME=$(/usr/libexec/java_home -v 21)
  ```
  日常 `./gradlew compileKotlin` / `./gradlew run` 用 Android Studio JBR
  也行（不需要 jpackage），所以只有正式打包时切到 Temurin。
- 服务器 SSH 访问（产物 scp 到 `data/desktop-binaries/`，详见
  「分发策略」一节；**不用** `gh release create`）

### 跑起来

```bash
cd apps/desktop
./gradlew run            # 开发模式直接启动窗口，热重载靠 IntelliJ
./gradlew runDistributable    # 打成 native bundle 后启动，更接近最终用户体验
```

### 打包

```bash
# 当前主机能产出什么就产出什么
./gradlew packageDistributionForCurrentOS

# Mac 上：
./gradlew packageDmg     # 产出 build/compose/binaries/main/dmg/ByWaveCalendar-0.1.0.dmg

# Windows 上：
./gradlew packageMsi     # 产出 build\compose\binaries\main\msi\ByWaveCalendar-0.1.0.msi

# Linux 上：
./gradlew packageDeb
```

⚠️ JetBrains 的 Compose Desktop 打包是 **host-dependent** —— Mac DMG 只能在 macOS 上产；Win MSI 只能在 Windows 上产；Linux DEB 只能在 Linux 上产。后续考虑用 GitHub Actions 三平台 matrix 一次产全。

## macOS 签名 + 公证

未签名的 DMG 用户首次打开会被 Gatekeeper 拦下「无法验证开发者」。
要绕过：System Settings → Privacy → 允许；或者**我们自己签 + Apple 公证一次性解决**。

签名走 Apple Developer ID Application 证书（**不是** Apple Distribution，
后者是 App Store 专用）。一次性设置：

1. https://developer.apple.com → Certificates → 新建「Developer ID
   Application」证书 → 下载 .cer 双击装到 Keychain
2. https://appleid.apple.com → Sign-In Security → App-Specific Passwords
   → 生成一个，记下来
3. 在 shell 里设环境变量（写到 ~/.zshrc 之类）：

```bash
export APPLE_DEVELOPER_ID_APPLICATION="Developer ID Application: 赵润森 (XXXXXXXXXX)"
export APPLE_NOTARY_APPLE_ID="z2998442867@gmail.com"
export APPLE_NOTARY_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific password
export APPLE_NOTARY_TEAM_ID="XXXXXXXXXX"             # 10-char Team ID
```

4. 再跑 `./gradlew packageDmg` —— Gradle 自动签 + 上传公证 + staple ticket。
   Apple 公证服务一般 5-15 分钟返回，整条 pipeline 跑完 DMG 直接是
   "verified developer" 状态。

## Windows 签名

可选。没签的 MSI 装机时 Windows SmartScreen 会弹「未知发布者」警告，
用户点「仍要运行」就过。要完全去掉警告需要购买 EV Code Signing 证书
（DigiCert / Sectigo 等，~$400/年），通常 v1.0 才上。v0.x 先跳过。

## 发布到 rl.lz-ss.com

发版 manifest 在 `apps/desktop/releases/latest.json`（committed），
schema 见 `src/lib/desktop_release.ts`：

```json
{
  "versionCode": 2,
  "versionName": "0.2.0",
  "releasedAt": "2026-05-28T00:00:00Z",
  "notes": "首版扫码登录上线",
  "mandatory": false,
  "assets": {
    "mac":   { "filename": "ByWaveCalendar-0.2.0.dmg", "sha256": "...", "sizeBytes": 81234567 },
    "win":   { "filename": "ByWaveCalendar-0.2.0.msi", "sha256": "...", "sizeBytes": 84567890 },
    "linux": { "filename": "bywave-calendar_0.2.0-1_amd64.deb", "sha256": "...", "sizeBytes": 79123456 }
  }
}
```

发布步骤：

```bash
# 1. Mac 上打 + 公证
./gradlew packageDmg
shasum -a 256 build/compose/binaries/main/dmg/ByWaveCalendar-0.2.0.dmg

# 2. Windows 上打
./gradlew packageMsi

# 3. 把两个产物 scp 到服务器
scp build/compose/binaries/main/dmg/*.dmg \
  user@rl.lz-ss.com:~/by-wave-calendar/data/desktop-binaries/
# (Windows 上同样 scp .msi)

# 4. 本地编辑 apps/desktop/releases/latest.json 填好 sha256 + sizeBytes
#    git commit && git push && pm2 reload by-wave-calendar
```

下载页 https://rl.lz-ss.com/download 会自动从 manifest 渲染当前
可下载平台的按钮；缺少哪个平台的 asset，那个按钮显示「即将发布」。

## 项目结构

```
apps/desktop/
├── settings.gradle.kts     # 模块声明 + Compose JetBrains repo
├── build.gradle.kts        # Compose Desktop 插件 + 三平台打包配置
├── gradle.properties       # JVM args + Kotlin 2.0 K2
├── gradle/wrapper/
│   └── gradle-wrapper.properties     # Gradle 8.9
└── src/main/
    ├── kotlin/cn/bywave/calendar/desktop/
    │   └── Main.kt         # 入口：窗口 + brand splash
    └── resources/          # 图标 / 静态资源（v0.2 加）
```

后续 v0.2 拆出 `auth/` `data/` `ui/` 子包，跟 Android 结构对齐。
