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

# 2. (Optional) Write polished release notes for the in-app updater
#    sheet — Markdown plain text, newlines preserved.
#    Default note is "v<X.Y.Z> 发布" if you skip this.
cat > /tmp/v0.9.0-notes.txt <<EOF
v0.9 — <一句话主题>

• 第一个亮点
• 第二个亮点
• 修复 …
EOF

# 3. Run the all-in-one release script.
./scripts/release.sh --notes-from=/tmp/v0.9.0-notes.txt --push
```

What `release.sh` does:

1. Reads `versionCode` + `versionName` from `app/build.gradle.kts`
2. Refuses to continue if a GitHub Release with that tag already exists
3. Runs `assembleRelease`
4. **Verifies the signing certificate fingerprint matches the canonical
   keystore** (defense against a recovered backup having a different
   key — that'd lock every existing user out of in-place updates)
5. Computes SHA-256 + size
6. `gh release create` with the APK attached
7. Updates `apps/android/releases/latest.json` with new values
8. (with `--push`) commits + pushes to GitHub and Gitee

Flags:

| Flag | What it does |
|---|---|
| `--push` | Commit + push manifest to both remotes. Without this, the manifest changes stay in your working tree for review. |
| `--mandatory` | Mark this release as forced upgrade (locks the APP until install). For critical bugs. |
| `--notes-from=FILE` | Use FILE's contents as both GitHub release notes AND the in-app updater notes. |

After the script:

- **Server**: runs `git pull` (or wait for cron) to pick up the manifest.
- **Installed APPs**: poll within 6 hours of next resume, or force via Settings → 检查更新.

If you skip `--push`, the script still creates the GitHub Release (that
half is durable). Use `gh release delete <tag> --yes` to undo and rerun.
