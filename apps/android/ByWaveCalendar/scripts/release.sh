#!/usr/bin/env bash
# Android release automation. One command from a clean tree to a
# published version that all installed APPs will pick up within 6h.
#
# Steps (each gated, so a half-finished run can be resumed):
#   1. Read versionCode + versionName from app/build.gradle.kts
#   2. Assemble signed release APK
#   3. Verify signature + cert fingerprint matches the keystore on record
#   4. Compute sha256 + sizeBytes
#   5. Stage APK in /tmp under the canonical filename
#   6. Create GitHub Release tagged `android-v<versionName>` with the APK
#   7. Update apps/android/releases/latest.json with the new metadata
#   8. (with --push) git add + commit + push to both remotes
#
# Usage:
#   ./scripts/release.sh                          # build + GitHub release, no commit
#   ./scripts/release.sh --push                   # also commit + push manifest
#   ./scripts/release.sh --notes-from=notes.md    # custom release notes file
#   ./scripts/release.sh --mandatory              # mark this release mandatory
#
# Requires:
#   - JAVA_HOME pointing at JDK 17+ (we auto-detect Android Studio's bundled JDK)
#   - ANDROID_HOME for build-tools/apksigner (also auto-detected)
#   - gh CLI logged in (`gh auth status`)
#   - ~/.gradle/gradle.properties with BYWAVE_KEYSTORE_PATH + passwords
#   - The keystore SHA-256 fingerprint matches EXPECTED_CERT_FP below
#     (sanity check — if you ever recover from backup, this confirms
#     you've got the right keystore before you ship a build that
#     locks every user out of in-place updates)

set -euo pipefail

cd "$(dirname "$0")/.."

# ---- args ----
PUSH=0
MANDATORY=0
NOTES_FILE=""
for a in "$@"; do
  case "$a" in
    --push) PUSH=1 ;;
    --mandatory) MANDATORY=1 ;;
    --notes-from=*) NOTES_FILE="${a#--notes-from=}" ;;
    *) echo "[release] unknown arg: $a" >&2; exit 2 ;;
  esac
done

# ---- env ----
if [ -z "${JAVA_HOME:-}" ]; then
  if [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
    export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    echo "[release] using Android Studio's bundled JDK"
  fi
fi
[ -n "${JAVA_HOME:-}" ] || { echo "[release] JAVA_HOME not set"; exit 1; }
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

# ---- read version from gradle ----
# Skip comment lines (`//` prefix after optional whitespace) — those
# describe what versionCode means but aren't the assignment we care
# about. Match only `<indent>versionCode = NUMBER` and
# `<indent>versionName = "..."`.
VERSION_CODE=$(awk '/^[[:space:]]*versionCode[[:space:]]*=/{gsub(/[^0-9]/, "", $0); print; exit}' app/build.gradle.kts)
VERSION_NAME=$(awk -F'"' '/^[[:space:]]*versionName[[:space:]]*=/{print $2; exit}' app/build.gradle.kts)
[ -n "$VERSION_CODE" ] || { echo "[release] could not parse versionCode"; exit 1; }
[ -n "$VERSION_NAME" ] || { echo "[release] could not parse versionName"; exit 1; }
TAG="android-v${VERSION_NAME}"
CANONICAL_FILENAME="bywave-calendar-${VERSION_NAME}.apk"

echo "[release] version: ${VERSION_NAME} (code ${VERSION_CODE})"
echo "[release] git tag: ${TAG}"

# ---- guard: don't accidentally re-publish ----
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "[release] ERROR: GitHub Release '$TAG' already exists."
  echo "[release] Either bump versionName in build.gradle.kts or delete the release:"
  echo "[release]   gh release delete $TAG --yes"
  exit 1
fi

# ---- build ----
echo "[release] gradle assembleRelease..."
./gradlew :app:assembleRelease

SRC_APK=app/build/outputs/apk/release/app-release.apk
[ -f "$SRC_APK" ] || { echo "[release] APK missing: $SRC_APK"; exit 1; }

# ---- verify signing fingerprint ----
# This is the keystore's cert SHA-256 — recorded in RELEASE.md as the
# canonical fingerprint. If a recovered backup yields a different cert,
# we'd publish a version that NO existing user can install on top of
# their existing APP (Android refuses to upgrade across signing keys).
# Fail loud rather than ship that.
EXPECTED_CERT_FP="e73fbb64ba0af2d3c39472bc12463888ccae9f9601bb71908f97ad60c2c102c7"
APKSIGNER=$(find "$ANDROID_HOME/build-tools" -maxdepth 2 -name apksigner | sort -V | tail -1)
[ -x "$APKSIGNER" ] || { echo "[release] apksigner not found under $ANDROID_HOME/build-tools"; exit 1; }
# apksigner has shifted output format between major versions:
#   build-tools 34.0.0  → "Signer #1 certificate SHA-256 digest: <hex>"
#   build-tools 37.0.0+ → "V2 Signer: certificate SHA-256 digest: <hex>"
# Both formats lead with some text and end with the SHA-256 hex digest
# after the last colon. Grep for the hex (64 lowercase hex chars) on a
# line that mentions "SHA-256" — survives any future format reshuffle.
ACTUAL_FP=$("$APKSIGNER" verify --print-certs "$SRC_APK" 2>/dev/null \
  | grep -i "SHA-256 digest" \
  | head -1 \
  | grep -oE '[0-9a-fA-F]{64}' \
  | head -1 \
  | tr '[:upper:]' '[:lower:]')
if [ "$ACTUAL_FP" != "$EXPECTED_CERT_FP" ]; then
  echo "[release] FATAL: signing certificate mismatch."
  echo "[release]   expected: $EXPECTED_CERT_FP"
  echo "[release]   got:      $ACTUAL_FP"
  echo "[release] This APK would be uninstallable for every existing user."
  echo "[release] Refusing to publish. Double-check ~/.bywave-android/release.jks."
  exit 1
fi
echo "[release] signing fingerprint matches the canonical keystore ✓"

# ---- stage APK + compute checksums ----
STAGE=/tmp/bywave-android-release
mkdir -p "$STAGE"
STAGE_APK="${STAGE}/${CANONICAL_FILENAME}"
cp "$SRC_APK" "$STAGE_APK"
SHA256=$(shasum -a 256 "$STAGE_APK" | awk '{print $1}')
SIZE=$(stat -f %z "$STAGE_APK" 2>/dev/null || stat -c %s "$STAGE_APK")
RELEASED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "[release] sha256: $SHA256"
echo "[release] size:   $SIZE bytes ($((SIZE/1024/1024)) MB)"

# ---- release notes ----
if [ -n "$NOTES_FILE" ]; then
  [ -f "$NOTES_FILE" ] || { echo "[release] notes file not found: $NOTES_FILE"; exit 1; }
  NOTES=$(cat "$NOTES_FILE")
else
  NOTES="Android ${VERSION_NAME} 发布。详细更新内容见 apps/android/releases/latest.json"
fi

# ---- create GitHub Release ----
# We upload two copies of the APK with different names:
#
#   bywave-calendar-X.Y.Z.apk   ← versioned, immutable, what /api/app/
#                                 android/latest hands to the in-app
#                                 updater. Asset URL stays unique
#                                 per release.
#   bywave-calendar.apk         ← stable filename, lives at the special
#                                 GitHub URL /releases/latest/download/
#                                 bywave-calendar.apk that always
#                                 points at the most recent release.
#                                 This is what the README's "Download
#                                 APK" badge links to — without it the
#                                 README would need a manual edit on
#                                 every release.
#
# Both files are byte-identical (same SHA-256 → in-app updater's check
# passes for the latest URL too), they just serve different lookup
# patterns.
STAGE_APK_STABLE="${STAGE}/bywave-calendar.apk"
cp "$STAGE_APK" "$STAGE_APK_STABLE"

echo "[release] gh release create $TAG ..."
gh release create "$TAG" "$STAGE_APK" "$STAGE_APK_STABLE" \
  --title "Android v${VERSION_NAME}" \
  --notes "$NOTES" \
  >/dev/null

# ---- compute download URL (canonical pattern, not the API URL) ----
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${CANONICAL_FILENAME}"
echo "[release] download URL: $DOWNLOAD_URL"

# ---- update manifest ----
MANIFEST=../../android/releases/latest.json
# Resolve relative to script dir (project app dir → ../../android/releases)
MANIFEST=$(cd "$(dirname "$0")/.." && pwd)/../releases/latest.json
[ -f "$MANIFEST" ] || { echo "[release] manifest missing: $MANIFEST"; exit 1; }

# Preserve user-provided notes from the existing manifest unless caller
# overrode them via --notes-from. The latest.json `notes` field shows in
# the in-app updater sheet, which deserves separate, more polished copy
# than the auto-generated GitHub release notes.
EXISTING_NOTES=$(python3 -c "import json,sys; print(json.load(open('$MANIFEST'))['notes'])" 2>/dev/null || echo "")
if [ -n "$NOTES_FILE" ]; then
  MANIFEST_NOTES=$(python3 -c "import json,sys; print(json.dumps(open('$NOTES_FILE').read()))")
else
  # Keep the existing notes if they look like they're for THIS version;
  # otherwise fall back to a template. Pass EXISTING_NOTES via the
  # environment (NOT interpolated into the Python source) — the previous
  # release's notes are multi-line, and splicing them into a single-quoted
  # literal produced "SyntaxError: unterminated string literal" and aborted
  # the manifest update mid-release.
  MANIFEST_NOTES=$(BWC_EXISTING_NOTES="$EXISTING_NOTES" BWC_VN="$VERSION_NAME" python3 -c "import json,os; print(json.dumps(os.environ['BWC_EXISTING_NOTES'] or ('v'+os.environ['BWC_VN']+' 发布')))")
fi

# Python case for the JSON-edit heredoc below — the heredoc substitutes
# this verbatim into a Python literal, so we use Python's True/False
# casing here. (`false` would crash the heredoc with NameError because
# Python doesn't recognize bash booleans.)
MANDATORY_BOOL=$([ "$MANDATORY" -eq 1 ] && echo "True" || echo "False")

python3 - <<PY
import json, pathlib
p = pathlib.Path("$MANIFEST")
d = json.loads(p.read_text())
d.update({
    "versionCode": $VERSION_CODE,
    "versionName": "$VERSION_NAME",
    "filename": "$CANONICAL_FILENAME",
    "downloadUrl": "$DOWNLOAD_URL",
    "sha256": "$SHA256",
    "sizeBytes": $SIZE,
    "releasedAt": "$RELEASED_AT",
    # MANIFEST_NOTES was already JSON-encoded via json.dumps(...) above,
    # so it's substituted as a raw JSON literal here (no surrounding
    # quotes — they're inside the value). Without this line the in-app
    # updater sheet would show whatever the PREVIOUS release's notes were.
    "notes": $MANIFEST_NOTES,
    "mandatory": $MANDATORY_BOOL,
})
# Preserve notes + minSupportedVersionCode unless this script was given
# an explicit override (handled out-of-band by the caller editing the file).
p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
print("[release] manifest updated:", p)
PY

# ---- commit + push (gated by --push) ----
if [ "$PUSH" -eq 1 ]; then
  echo "[release] committing + pushing..."
  REPO_ROOT=$(git rev-parse --show-toplevel)
  cd "$REPO_ROOT"
  git add apps/android/releases/latest.json
  git commit -m "$(cat <<EOF
android: 发布 v${VERSION_NAME} (versionCode ${VERSION_CODE})

GitHub Release: ${DOWNLOAD_URL}
SHA-256: ${SHA256}
Size: $((SIZE/1024/1024)) MB

(自动生成自 apps/android/ByWaveCalendar/scripts/release.sh)
EOF
)"
  git push origin main
  if git remote get-url gitee >/dev/null 2>&1; then
    git push gitee main
  fi
  echo "[release] pushed to GitHub + Gitee"
else
  echo "[release] manifest changed but NOT committed (re-run with --push to do that)"
fi

echo
echo "[release] DONE — Android v${VERSION_NAME} published."
echo "[release] Next: server runs 'git pull' (or wait for cron) to pick up the manifest."
echo "[release] Installed APPs poll within 6h of resume; force from Settings → 检查更新."
