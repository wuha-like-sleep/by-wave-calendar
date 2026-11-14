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

### Mac 本地签名与公证

正式发行使用 [本地发布脚本](../../scripts/release-macos.py)。需要完整 JDK 21、Xcode 命令行工具、
钥匙串中的 Developer ID Application 证书与私钥，以及已验证的 notarytool 钥匙串配置。
凭据只保留在本机，不导出私钥，不上传到仓库或 GitHub Secrets。
发布脚本的离线检查：`python3 -m unittest discover -s scripts -p test_release_macos.py`。

```bash
# 在仓库根目录执行；从输出中选取对应团队的 Developer ID Application 指纹。
security find-identity -v -p codesigning

# 首次配置：在本机交互输入 Apple ID、团队 ID 和应用专用密码。
# 也可用已有 App Store Connect API 密钥配置；不要把密码或私钥写进命令历史。
xcrun notarytool store-credentials bywave-calendar

python3 scripts/release-macos.py build \
  --identity YOUR_CERTIFICATE_SHA1 --team-id YOUR_TEAM_ID \
  --java-home /absolute/path/to/jdk-21/Contents/Home

# 上一步会打印 /private/tmp 中的独立 staging 目录。
python3 scripts/release-macos.py notarize \
  --stage /private/tmp/bywave-macos-ARCH-XXXX \
  --keychain-profile bywave-calendar --output /absolute/path/to/releases
```

JDK 架构决定安装包架构：Apple Silicon 使用 arm64 JDK，Intel 使用 x64 JDK。
Apple Silicon 可安装 Rosetta 后用 x64 JDK 本地构建 Intel 版本；两个架构分别运行测试。
临时构建放在 `/private/tmp`，避免 iCloud / File Provider 给应用写入签名不允许的元数据。

脚本使用证书指纹精确选择身份，支持钥匙串中多个同名续期证书。它签名应用、JVM、
原生图形库及 JAR 内嵌原生库，启用 hardened runtime 和安全时间戳，保留库验证。
JVM 仅获得 JIT 所需的可执行内存权限，不开启调试权限。
先公证并装订应用，再生成品牌 DMG、签名、公证并装订 DMG。
JDK 21 的 `jpackage` 会在封装时把输入应用改成临时签名，因此发布脚本保留它生成的
安装窗口布局，再原样放回已公证的应用，并在提交 DMG 前验证内部应用的签名与票据。
最终检查 Gatekeeper、内嵌应用、公证日志、架构和 SHA-256 后，才导出安装包。
`build` 成功仅代表已签名；只有 `notarize` 输出 `Verified, notarized installer` 才可发布。

提交 ID 保存在 staging 目录，网络中断后重跑同一条 `notarize` 命令可继续等待，
不会重复提交已有任务。Apple 返回拒绝或警告时停止发布，先检查目录中的公证日志。
签名后不要修改应用内容；需要重建时重新执行 `build`，不要复用旧公证任务。

### Windows 本地测试安装包

需要 Windows、完整 x64 JDK 21、WiX 3 和 Python 3.11 或更新版本。Windows ARM64
可通过系统的 x64 模拟运行这些工具，生成的安装器仍是 x64。无需修改 PowerShell 执行策略。
在仓库根目录执行：

```powershell
python scripts/package-windows-local.py --java-home "C:\Tools\jdk-21" --wix-home "C:\Tools\wix3" --output "C:\Builds\bywave-test" --unsigned-test-package
```

脚本将源码复制到本机临时目录，运行桌面测试、品牌安装器打包和原生架构检查，输出带有
`local-test` 标记的 MSI、SHA-256 和校验记录。Windows 专属测试会实际运行 PowerShell，
覆盖中文和特殊字符路径、安装成功、需要重启、用户取消及失败分支。
构建失败时保留临时目录便于查看日志；输出目录已有不同内容的同名安装包时拒绝覆盖。

此入口只用于没有代码签名证书时的本地测试，安装器会显示未知发布者。
它不修改版本或更新清单，也不发布和替换发行附件。同版本测试包须先卸载旧测试包再安装；
正式升级必须递增版本，并配置 Windows 代码签名后另行验证。

## 分发与更新清单

所有平台均在本地打包，GitHub 仅托管源码和已验证的发行附件，不运行云端打包。
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
GitHub 桌面打包工作流已移除，云端 CI 也已停用；检查在本地执行。
Windows 在 Windows 本机运行 `gradlew.bat test packageBrandedMsi`，Linux 本地运行 `./gradlew test packageDeb`。
发布前核对实际安装包 SHA-256、大小、架构、签名状态与更新清单。
已发布附件不可覆盖，否则会使已部署清单中的校验值失效；补签安装包使用新文件名。
相同版本的补签包不会触发已安装同版本客户端的版本升级提示，可从下载页重新安装。

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
