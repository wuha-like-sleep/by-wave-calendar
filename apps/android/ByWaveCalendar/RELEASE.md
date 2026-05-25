# Android Release Process

Signed release APKs ship to users via the in-app updater (see
`deploy/android-release.md` in the repo root). This doc covers the
"how do I build + sign an APK" half of that pipeline.

## ⚠️ The keystore is irreplaceable

Android packages are tied to the signing key forever. If you lose
`~/.bywave-android/release.jks` you can NEVER ship an in-place update
again — users have to uninstall + reinstall, losing local data.

**Back the keystore up to:**
- 1Password (encrypted)
- An external drive (encrypted)
- Optionally, an offline USB stored physically separately

Back up `~/.gradle/gradle.properties` too — without the passwords the
keystore is useless. Both files are gitignored and never make it into
the repo.

Keystore SHA-256 fingerprint (so you can verify a recovered backup):

```
E7:3F:BB:64:BA:0A:F2:D3:C3:94:72:BC:12:46:38:88:CC:AE:9F:96:01:BB:71:90:8F:97:AD:60:C2:C1:02:C7
```

(Generated 2026-05-25, validity 10000 days.)

## One-time setup

If you're on a fresh machine and need to restore signing capability:

```bash
# Restore keystore from your 1Password backup
mkdir -p ~/.bywave-android && chmod 700 ~/.bywave-android
cp /path/to/backup/release.jks ~/.bywave-android/release.jks
chmod 600 ~/.bywave-android/release.jks

# Restore gradle properties (or recreate from 1Password)
cat >> ~/.gradle/gradle.properties <<EOF
BYWAVE_KEYSTORE_PATH=/Users/$(whoami)/.bywave-android/release.jks
BYWAVE_KEYSTORE_PASSWORD=<from 1Password>
BYWAVE_KEY_ALIAS=bywave
BYWAVE_KEY_PASSWORD=<from 1Password>
EOF
chmod 600 ~/.gradle/gradle.properties

# Verify
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
"$JAVA_HOME/bin/keytool" -list \
  -keystore ~/.bywave-android/release.jks \
  -storepass "$(grep '^BYWAVE_KEYSTORE_PASSWORD=' ~/.gradle/gradle.properties | cut -d= -f2-)"
# Compare the printed SHA-256 fingerprint with the one above.
```

## Cutting a release

```bash
cd apps/android/ByWaveCalendar

# 1. Bump versionCode + versionName in app/build.gradle.kts
#    versionCode MUST monotonically increase. versionName is human.

# 2. Build the signed APK.
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew :app:assembleRelease

# 3. Find the APK + compute checksum + size for the manifest.
APK=app/build/outputs/apk/release/app-release.apk
shasum -a 256 "$APK"
stat -f %z "$APK"   # macOS — size in bytes

# 4. Rename to the convention used by the in-app updater.
VERSION=$(grep 'versionName =' app/build.gradle.kts | head -1 | sed 's/.*"\(.*\)".*/\1/')
cp "$APK" "/tmp/bywave-calendar-${VERSION}.apk"
```

## Publishing

See `../../deploy/android-release.md` for the server-side steps:
upload APK to `data/android-apks/`, edit `data/app-android-manifest.json`,
verify with `curl /api/app/android/latest`.

Installed APPs will pick up the new version within 6 hours on resume.
