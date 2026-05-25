# Android Release Publishing

The Android APP polls `/api/app/android/latest` on resume. To publish a new
release that triggers the in-app updater across all installed APPs:

## 1. Build the signed APK

On your dev machine, in `apps/android/ByWaveCalendar/`:

```bash
# Bump versionCode + versionName in app/build.gradle.kts first.
./gradlew assembleRelease
# Output: app/build/outputs/apk/release/app-release.apk
```

If you haven't created a signing keystore yet, see `apps/android/ByWaveCalendar/README.md`.

## 2. Compute SHA-256 + size

```bash
shasum -a 256 app-release.apk     # → e.g. abc123...
stat -f %z app-release.apk        # macOS — file size in bytes
# or: wc -c < app-release.apk     # cross-platform
```

## 3. Drop files on the server

```bash
# On the server (~/sites/bywave-calendar/):
mkdir -p data/android-apks
scp /local/path/app-release.apk server:~/sites/bywave-calendar/data/android-apks/bywave-calendar-0.8.0.apk
```

Filename convention: `bywave-calendar-<versionName>.apk`. Old APKs can
stay (each release URL is content-addressed by filename) but eventually
prune them to save disk.

## 4. Update the manifest

Edit `data/app-android-manifest.json` (create if missing):

```json
{
  "versionCode": 8,
  "versionName": "0.8.0",
  "filename": "bywave-calendar-0.8.0.apk",
  "sha256": "abc123...",
  "sizeBytes": 15400000,
  "releasedAt": "2026-05-25T12:00:00Z",
  "notes": "v0.8 — APP 内自动更新\n• 检测到新版本自动提示\n• 一键下载 + 安装\n• 强制升级支持（修紧急 bug 时推一次）",
  "mandatory": false,
  "minSupportedVersionCode": 1
}
```

Field meanings:

| Field | Purpose |
|---|---|
| `versionCode` | Integer, must be > current installed. The APP compares this. |
| `versionName` | Human string shown in the update sheet. |
| `filename` | Must match the file you dropped in `data/android-apks/`. |
| `sha256` | Lowercase hex. APP verifies the downloaded file matches. |
| `sizeBytes` | For download progress UI. |
| `releasedAt` | ISO 8601. Shown as "发布于 X 天前". |
| `notes` | Multi-line release notes shown in the update sheet. |
| `mandatory` | `true` → APP locks until the user updates. Use only for critical bugs. |
| `minSupportedVersionCode` | Any APP with versionCode < this gets the mandatory lock, even if this release is non-mandatory. Retroactive critical-bug flag. |

The server mtime-caches the manifest — edits are picked up immediately.

## 5. Verify

```bash
curl https://rl.lz-ss.com/api/app/android/latest
# Should return the JSON above with `url` populated.
curl -I https://rl.lz-ss.com/downloads/android/bywave-calendar-0.8.0.apk
# Should return 200 + Content-Type: application/vnd.android.package-archive
```

Then open the APP on a test device. Within 6 hours (or on next launch
after the throttle window) it should detect the update.

## Rollback

If you ship a broken release: revert `data/app-android-manifest.json` to
the previous version (or just delete it — the APP gracefully treats a
404 as "no update available" and keeps running). APKs already downloaded
to user devices are unaffected unless the user manually clears cache.
