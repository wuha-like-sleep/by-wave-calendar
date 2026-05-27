# ByWave Calendar — Desktop (macOS / Windows / Linux)

Compose Multiplatform Desktop 桌面端。Mac DMG + Win MSI + Linux DEB
一份 Kotlin 代码出三平台原生 app（Skia 渲染，不是 WebView 套壳）。

## 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| v0.1 | 项目脚手架 + brand splash 窗口 + 跳浏览器按钮 + DMG/MSI 打包配置 | ✅ 当前 |
| v0.2 | 登录页（用户名密码 / QR 扫码）+ 网络层 (Ktor)| 待 |
| v0.3 | 日/周/月视图（复用 Android Compose 逻辑）| 待 |
| v0.4 | 事件 CRUD + 邀请人 | 待 |
| v0.5 | 多账号 + 设置页 | 待 |
| v0.6 | 系统日历镜像（macOS EventKit + Win Outlook COM）| 待 |
| v1.0 | 对齐 iOS / Android 全部功能 + 自动更新（Sparkle 或自家 polling）| 目标 |

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
- gh CLI 登录（用于发布到 GitHub Releases）

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
