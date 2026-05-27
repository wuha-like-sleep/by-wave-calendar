# ByWave Calendar — Desktop (macOS / Windows / Linux)

Compose Multiplatform Desktop 桌面端。Mac DMG + Win MSI + Linux DEB
一份 Kotlin 代码出三平台原生 app（Skia 渲染，不是 WebView 套壳）。

## 分发策略

桌面端是 **server-agnostic** 的开源客户端 —— 默认输入框是空的，
用户填自己的 ByWave 服务器地址。所以分发跟 Android 完全一样：

- **主路径：GitHub Releases**（也镜像到 Gitee）。一份 .dmg / .msi /
  .deb 走天下，谁自建 ByWave 都能拿来连自己的服务器。
- **服务器自托管 fallback**：如果你的部署不想让用户依赖 GitHub，
  manifest 的 `downloadUrl` 留空，把二进制放在
  `data/desktop-binaries/<filename>`，服务器从
  `/downloads/desktop/<filename>` 串流。

任何 ByWave 部署都可以二选一或两个一起暴露 —— `/download` 页面会
按当前 manifest 渲染。

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
- gh CLI 登录（推荐路径：把产物 `gh release create` 到 GitHub
  Releases；或者 scp 到生产服 `data/desktop-binaries/` 自托管，
  详见「发布」一节）

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

## 发布

发版 manifest 在 `apps/desktop/releases/latest.json`（committed），
schema 见 `src/lib/desktop_release.ts`。每个 asset 二选一：
`downloadUrl` 走 GitHub Releases（推荐），或者 `filename` 走服务器
自托管（不要 GitHub 时用）。

```json
{
  "versionCode": 2,
  "versionName": "0.2.0",
  "releasedAt": "2026-05-28T00:00:00Z",
  "notes": "首版扫码登录上线",
  "mandatory": false,
  "assets": {
    "mac": {
      "downloadUrl": "https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v0.2.0/ByWaveCalendar-0.2.0.dmg",
      "sha256": "...",
      "sizeBytes": 81234567
    },
    "win": {
      "downloadUrl": "https://github.com/wuha-like-sleep/by-wave-calendar/releases/download/desktop-v0.2.0/ByWaveCalendar-0.2.0.msi",
      "sha256": "...",
      "sizeBytes": 84567890
    },
    "linux": {
      "filename": "bywave-calendar_0.2.0-1_amd64.deb",
      "sha256": "...",
      "sizeBytes": 79123456
    }
  }
}
```

发布步骤（GitHub Releases 路径）：

```bash
# 1. Mac 上打 + 公证（需要 APPLE_* 环境变量，详见上面 macOS 签名）
./gradlew packageDmg
shasum -a 256 build/compose/binaries/main/dmg/ByWaveCalendar-0.2.0.dmg

# 2. Windows 上打
./gradlew packageMsi

# 3. 收齐两台机器的产物，gh release create 一次性传上去
gh release create desktop-v0.2.0 \
  --title "Desktop v0.2.0" --notes "首版扫码登录上线" \
  ByWaveCalendar-0.2.0.dmg ByWaveCalendar-0.2.0.msi

# 4. 编辑 apps/desktop/releases/latest.json 填好 downloadUrl + sha256
#    git commit && git push
```

自托管 fallback（不上 GitHub 时）：

```bash
scp build/compose/binaries/main/dmg/*.dmg \
  user@your-server:~/by-wave-calendar/data/desktop-binaries/
# manifest 用 "filename" 而不是 "downloadUrl"
```

任何 ByWave 部署的 `/download` 页都会按 manifest 渲染当前可下载
平台的按钮；缺哪个平台的 asset，那个按钮显示「即将发布」。

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
