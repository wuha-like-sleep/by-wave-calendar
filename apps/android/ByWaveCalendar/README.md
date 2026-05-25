# ByWave Calendar — Android

Kotlin + Jetpack Compose 原生 Android 客户端，配套 `apps/ios` 的 iOS APP，连接同一台 ByWave Calendar 服务器。

仅以 APK 形式分发（不上 Google Play、不上国内应用商店）。

## 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| v0.1 | 项目脚手架 + 邮箱密码登录 + 日视图 | ✅ |
| v0.2 | 日/周/月 三视图 + 事件详情底部弹窗 + 15 个月宽窗口缓存 | ✅ |
| v0.3 | 事件 CRUD（新建 / 编辑 / 删除）+ QR 扫码登录 + 设置页 | ✅ |
| v0.4 | Room 离线缓存 + MFA TOTP 验证 + 邀请人管理 | ✅ |
| v0.5 | 多账号 (Profile) + 头像角标切换器 + 添加另一账号 | ✅ |
| v0.6 | 系统日历镜像 + 本地提醒（AlarmManager + 通知 channel）+ 设置开关 | ✅ |
| v0.7 | 全局搜索 + 长按事件菜单（编辑 / 复制 / 邀请人 / 删除）+ 深色模式 audit | ✅ |
| v0.8 | 签名 release APK 流程 + 自动构建上传 | 待开发 |
| v1.0 | 对齐 iOS v1.3.x 全部功能 | 目标 |

## 技术栈

- **Kotlin** 2.0 / **Jetpack Compose** with Material 3
- **Retrofit** + **kotlinx.serialization** for the REST API
- **EncryptedSharedPreferences** for refresh-token storage (Android Keystore-backed AES-GCM)
- **Room** (planned for v0.2) for offline event cache
- **CameraX** + **ML Kit Barcode** (registered in deps, wired in v0.2) for QR scanning
- **minSdk 26** (Android 8.0) → 覆盖 ~95% 在用设备

## 怎么构建 / 调试

1. 装 Android Studio Hedgehog (2023.1.1) 或更新
2. `File → Open` 选这个目录（`apps/android/ByWaveCalendar`）
3. 等 Gradle sync 完毕，自动下载 wrapper + 依赖
4. 顶部工具栏选目标设备（真机或模拟器）→ ▶️ Run

第一次 sync 会拉 ~500MB 依赖（AGP / Compose BOM / Room / CameraX），后续都是缓存。

## 怎么打 release APK

签名 keystore 不进仓库（见 `.gitignore`）。第一次发布前在本机：

```bash
keytool -genkeypair -v \
  -keystore bywave-release.jks \
  -alias bywave \
  -keyalg RSA -keysize 2048 -validity 10000
```

把 keystore 路径 + 密码写进 `~/.gradle/gradle.properties`：

```properties
BYWAVE_KEYSTORE_PATH=/path/to/bywave-release.jks
BYWAVE_KEYSTORE_PASSWORD=...
BYWAVE_KEY_ALIAS=bywave
BYWAVE_KEY_PASSWORD=...
```

然后在 `app/build.gradle.kts` 里 wire signing config（v0.2 加）。

## 包名

`cn.bywave.calendar`（跟 iOS bundle id 完全对齐）。Debug 构建会自动加 `.debug` 后缀，方便同一台手机装 release + debug 两个版本。

## 联系

软件层面：`info@by-wave.com` / GitHub Issues
账号 / 服务器层面：联系您绑定的服务器运营者
