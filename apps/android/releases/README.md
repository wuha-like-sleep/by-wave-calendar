# Android Release Manifest

This directory is the **committed** source of truth for what Android APP
clients see when they hit `/api/app/android/latest` on the server.

## How it flows

```
本机 (你)
  build signed APK
        │
        ▼
  gh release create android-v0.8.0 …apk
        │              │
        │              ▼
        │       GitHub Releases （hosts the APK binary）
        │
        ▼
  edit apps/android/releases/latest.json
  (sha256, sizeBytes, downloadUrl → GitHub URL)
        │
        ▼
  git push  ────────────►  GitHub + Gitee
                                  │
                                  ▼
                            server git pull
                                  │
                                  ▼
                /api/app/android/latest reads this JSON
                                  │
                                  ▼
                       Android APP sees the new version
```

## Publishing a new release

Detailed walkthrough lives in `apps/android/ByWaveCalendar/RELEASE.md`.
Short version:

```bash
# 1) Build signed APK locally
cd apps/android/ByWaveCalendar
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew :app:assembleRelease

# 2) Compute checksum + size
APK=app/build/outputs/apk/release/app-release.apk
shasum -a 256 "$APK"
stat -f %z "$APK"

# 3) Upload to GitHub Releases (any tag scheme — we use android-vX.Y.Z)
cd ../../..
cp apps/android/ByWaveCalendar/app/build/outputs/apk/release/app-release.apk \
   /tmp/bywave-calendar-X.Y.Z.apk
gh release create android-vX.Y.Z /tmp/bywave-calendar-X.Y.Z.apk \
  --title "Android vX.Y.Z — <one-liner>" \
  --notes "<markdown release notes>"

# 4) Get the asset URL
gh release view android-vX.Y.Z --json assets --jq '.assets[0].url'

# 5) Edit this directory's latest.json with new versionCode, versionName,
#    sha256, sizeBytes, downloadUrl, notes.
# 6) git commit + push
# 7) Server pulls + clients see the update within 6 hours
```

## Schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `versionCode` | integer | yes | Must monotonically increase. APP compares this. |
| `versionName` | string | yes | Human-readable, shown in update sheet. |
| `filename` | string | yes if no `downloadUrl` | Used to build the legacy server-hosted URL. |
| `downloadUrl` | string | yes if no `filename` | Absolute URL (GitHub Releases asset). |
| `sha256` | string | recommended | Lowercase hex. APP verifies the downloaded APK. |
| `sizeBytes` | integer | recommended | For progress UI. |
| `releasedAt` | string | recommended | ISO 8601 timestamp. |
| `notes` | string | recommended | Release notes shown in the update sheet, `\n`-separated. |
| `mandatory` | boolean | default `false` | Locks the APP until install completes. |
| `minSupportedVersionCode` | integer | default 1 | APPs below this get the mandatory lock retroactively. |

## Override at deploy time

If you need to ship a hotfix that hasn't been committed yet, drop a
manifest at `<projectRoot>/data/app-android-manifest.json` on the
server. The endpoint prefers that over this committed file, so you
can stage a release without a code push. Delete it when the committed
file catches up.
