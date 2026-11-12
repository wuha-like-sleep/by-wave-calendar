# ByWave Calendar Desktop

macOS、Windows、Linux 共用的 Kotlin / Compose Desktop 客户端。
用户连接自己的 ByWave 服务器；安装器为 DMG、MSI 和 DEB。

## 当前状态

当前版本由 `build.gradle.kts`、`BuildInfo.kt` 和 `releases/latest.json`
共同记录，三者须保持一致。仓库已实现：

- 扫码登录、多账号切换和独立的账号续期。
- 日、周、月、议程视图，以及事件创建、编辑、删除和重复规则。
- 事件缓存、搜索、设置、提醒和应用内更新。

macOS 通过 CalDAV 接入系统「日历」；新版、经典版 Outlook 通过 Microsoft 云端账号双向同步。
在客户端「设置 → 系统日历」配置；站长须先配置 Microsoft 应用 ID。
[配置与同步范围](../../docs/system-calendar-sync.md)包含重复事件、删除、冲突及备份恢复说明。

## 开发与检查

需要完整的 JDK 21。打安装器还需要 JDK 内的 `jpackage`；仅有运行时不够。

```bash
cd apps/desktop
./gradlew compileKotlin
./gradlew test
./gradlew run
```

测试会把 `user.home` 隔离到构建目录，避免改写开发机的真实登录资料。
Windows 可使用 `gradlew.bat` 执行相同任务。

## 打包

```bash
./gradlew packageBrandedDmg   # macOS
./gradlew packageBrandedMsi   # Windows
./gradlew packageDeb          # Linux
./gradlew runDistributable
```

使用上面的品牌安装器任务；默认 Compose `packageDmg` / `packageMsi` 不含自定义安装背景。产物位于
`build/compose/binaries/main/`。版本来自 `build.gradle.kts` 的 `version`，
不要单独写死 `packageVersion`，也不要更改 Windows 的 `upgradeUuid`。

macOS 本地签名配置见 `build.gradle.kts`，使用这些环境变量：

- `APPLE_DEVELOPER_ID_APPLICATION`：钥匙串中的 Developer ID Application 身份。
- `APPLE_NOTARY_APPLE_ID`、`APPLE_NOTARY_PASSWORD`、`APPLE_NOTARY_TEAM_ID`：公证凭据。

私钥、证书密码和公证凭据不得提交。发布前须验证产物签名与公证结果；
仅构建成功不代表安装器已签名。

## 分发与更新清单

[桌面发布工作流](../../.github/workflows/desktop-release.yml)包含各平台打包任务。
发布前同步以下版本字段：

| 文件 | 字段 |
|---|---|
| `build.gradle.kts` | `version` |
| `src/main/kotlin/cn/bywave/calendar/desktop/BuildInfo.kt` | `VERSION_NAME`、递增的 `VERSION_CODE` |
| `releases/latest.json` | `versionName`、`versionCode`、发布日期、说明、各平台产物 |

清单各平台的 `downloadUrl` 可指向 GitHub Releases。自托管时把安装器放在
服务端的 `data/desktop-binaries/`，并提供对应 `filename`。
每个产物的 `sha256` 和 `sizeBytes` 必须来自实际发布文件。

服务端 `/download` 页面和 `/api/app/desktop/latest` 读取此清单。
`mac` 对应 Apple Silicon，`macIntel` 对应 Intel；`win` 和 `linux` 对应 x64。
缺少某平台产物时不要填写其他平台的安装器；更新后分别验证下载和升级流程。
安装图标与背景由 `node scripts/build-desktop-branding.mjs` 在仓库根目录生成，源图案来自项目现有 SVG。
发布工作流仅允许手动触发，普通提交、PR 和标签均不自动打包。
手动构建须先确认可用额度，按需选择 Windows、Apple Silicon、Intel 或 Linux；仅需要完整发行时选择 all。
填写版本标签时只创建草稿发行版，校验实际安装包 SHA-256 后再更新清单和发布。
日常修改先运行本地测试和本地打包，复用已通过验证且客户端源码相同的 CI 安装包。
已发布附件不可覆盖，否则会使已部署清单中的校验值失效。

## 源码入口

Kotlin 源码位于 `src/main/kotlin/cn/bywave/calendar/desktop/`：

| 路径 | 内容 |
|---|---|
| `Main.kt`、`BuildInfo.kt` | 窗口入口和版本信息 |
| `data/api/`、`data/auth/` | API、会话与账号资料 |
| `data/cache/`、`data/notify/` | 缓存和提醒 |
| `data/update/` | 更新检查、下载与安装 |
| `ui/calendar/`、`ui/event/` | 日历视图和事件编辑 |
| `ui/auth/`、`ui/main/` | 登录、账号切换与设置 |
| `i18n/` | 多语言文案 |
