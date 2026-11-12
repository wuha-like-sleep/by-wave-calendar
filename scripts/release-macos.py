#!/usr/bin/env python3
"""Build and notarize macOS releases locally; never dispatch cloud jobs.

build creates a signed app in a fresh local staging directory. notarize resumes
that directory, stores submission IDs, staples the app before packaging, and
only copies verified installers to the requested output directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps/desktop"
BUNDLE_ID = "cn.bywave.calendar.desktop"
MACHO = {bytes.fromhex(x) for x in (
    "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"
)}


def run(*args, capture=False, **kwargs):
    result = subprocess.run([str(a) for a in args], check=True, text=True,
                            stdout=subprocess.PIPE if capture else None, **kwargs)
    return result.stdout.strip() if capture else None


def write_state(stage, state):
    temporary = stage / "state.tmp"
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.replace(stage / "state.json")


def identity_check(identity, team):
    if not re.fullmatch(r"[0-9A-Fa-f]{40}", identity):
        raise ValueError("Use the exact SHA-1 fingerprint from security find-identity -v -p codesigning")
    identities = run("security", "find-identity", "-v", "-p", "codesigning", capture=True)
    pattern = rf'{re.escape(identity)} "Developer ID Application: [^"\n]+ \({re.escape(team)}\)"'
    if not re.search(pattern, identities, re.IGNORECASE):
        raise ValueError("No valid Developer ID Application identity for the selected fingerprint and team")


def sign(path, identity, entitlements=False):
    args = ["codesign", "--force", "--sign", identity, "--timestamp", "--options", "runtime"]
    if entitlements:
        args += ["--entitlements", DESKTOP / "packaging/entitlements.plist"]
    run(*args, path)
    run("codesign", "--verify", "--strict", path)


def is_macho(path):
    with path.open("rb") as f:
        return f.read(4) in MACHO


def sign_jar(jar, identity):
    # Compose extracts the host library but can leave another Mach-O in the JAR.
    # Apple's scanner examines these too. Read entries without extracting paths.
    with zipfile.ZipFile(jar) as source:
        native = [i for i in source.infolist() if not i.is_dir()
                  and i.filename.endswith((".dylib", ".jnilib"))]
        if not native:
            return
        if any(re.match(r"META-INF/[^/]+\.(SF|RSA|DSA|EC)$", n, re.I) for n in source.namelist()):
            raise ValueError(f"Refusing to invalidate a signed JAR: {jar.name}")
        replacements = {}
        with tempfile.TemporaryDirectory(prefix="bywave-native-", dir="/private/tmp") as folder:
            for index, info in enumerate(native):
                path = Path(folder) / f"library-{index}.dylib"
                path.write_bytes(source.read(info))
                if is_macho(path):
                    sign(path, identity)
                    replacements[info.filename] = path.read_bytes()
                    checksum_name = info.filename + ".sha256"
                    if checksum_name in source.namelist():
                        replacements[checksum_name] = hashlib.sha256(path.read_bytes()).hexdigest().encode()
            if not replacements:
                return
            destination = jar.with_suffix(".jar.new")
            with zipfile.ZipFile(destination, "w") as output:
                output.comment = source.comment
                for info in source.infolist():
                    output.writestr(info, replacements.get(info.filename, source.read(info)))
    destination.replace(jar)


def validate_app(app, team, architecture):
    with (app / "Contents/Info.plist").open("rb") as f:
        info = plistlib.load(f)
    if info.get("CFBundleIdentifier") != BUNDLE_ID:
        raise ValueError("Unexpected application bundle identifier")
    for binary in [app / "Contents/MacOS/ByWaveCalendar",
                   app / "Contents/runtime/Contents/Home/lib/server/libjvm.dylib",
                   app / f"Contents/app/libskiko-macos-{'arm64' if architecture == 'arm64' else 'x64'}.dylib"]:
        if architecture not in run("lipo", "-archs", binary, capture=True).split():
            raise ValueError(f"Wrong native architecture: {binary}")
    run("codesign", "--verify", "--deep", "--strict", "--verbose=2", app)
    details = subprocess.run(["codesign", "-dvv", str(app)], check=True,
                             capture_output=True, text=True).stderr
    if f"TeamIdentifier={team}" not in details or "runtime" not in details or "Timestamp=" not in details:
        raise ValueError("Application lacks the expected team, hardened runtime or secure timestamp")
    actual_entitlements = plistlib.loads(subprocess.run(
        ["codesign", "-d", "--entitlements", "-", "--xml", str(app)],
        check=True, capture_output=True).stdout)
    expected_entitlements = {
        "com.apple.security.cs.allow-jit": True,
        "com.apple.security.cs.allow-unsigned-executable-memory": True,
    }
    if actual_entitlements != expected_entitlements:
        raise ValueError("Unexpected application entitlements; library validation and debugging protections must remain enabled")
    return info


def build(args):
    identity_check(args.identity, args.team_id)
    java = Path(args.java_home or os.environ.get("JAVA_HOME", "")).expanduser().resolve()
    if not (java / "bin/jpackage").is_file():
        raise ValueError("--java-home must name a full JDK 21 with jpackage")
    architecture = run("lipo", "-archs", java / "bin/java", capture=True)
    if architecture not in ("arm64", "x86_64"):
        raise ValueError(f"Unsupported JDK architecture: {architecture}")
    java_version = subprocess.run([str(java / "bin/java"), "-version"], check=True,
                                  text=True, capture_output=True).stderr
    if not re.search(r'version "21[.\"]', java_version):
        raise ValueError("Use JDK 21 for this desktop release")
    stage = Path(tempfile.mkdtemp(prefix=f"bywave-macos-{architecture}-", dir="/private/tmp"))
    print(f"Staging directory: {stage}", flush=True)
    # Avoid File Provider/iCloud metadata invalidating bundle signatures.
    init = stage / "build.init.gradle"
    init.write_text(f"allprojects {{ layout.buildDirectory.set(file('{stage}/build')) }}\n")
    env = os.environ.copy()
    env["JAVA_HOME"] = str(java)
    env["PATH"] = str(java / "bin") + os.pathsep + env["PATH"]
    run(DESKTOP / "gradlew", "-p", DESKTOP, "-I", init,
        "test", "createDistributable", "--no-daemon", env=env)
    app = stage / "build/compose/binaries/main/app/ByWaveCalendar.app"
    for jar in sorted(app.rglob("*.jar")):
        sign_jar(jar, args.identity)
    for path in sorted(app.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if path.is_file() and not path.is_symlink() and is_macho(path):
            sign(path, args.identity, entitlements=True)
            checksum = path.with_name(path.name + ".sha256")
            if checksum.is_file():
                checksum.write_text(hashlib.sha256(path.read_bytes()).hexdigest())
    sign(app / "Contents/runtime", args.identity, entitlements=True)
    sign(app, args.identity, entitlements=True)
    info = validate_app(app, args.team_id, architecture)
    state = {"app": str(app), "identity": args.identity, "team": args.team_id,
             "architecture": architecture, "javaHome": str(java),
             "version": info["CFBundleShortVersionString"],
             "sourceCommit": run("git", "-C", ROOT, "rev-parse", "HEAD", capture=True),
             "sourceDirty": bool(run("git", "-C", ROOT, "status", "--porcelain", capture=True))}
    write_state(stage, state)
    print(f"Signed app ready; NOT notarized. Continue with:\n"
          f"python3 scripts/release-macos.py notarize --stage {stage} "
          "--keychain-profile YOUR_PROFILE --output /absolute/path/to/releases", flush=True)


def notarize_file(path, stage, state, key, profile):
    auth = ["--keychain-profile", profile]
    if key not in state:
        reply = json.loads(run("xcrun", "notarytool", "submit", path, *auth,
                               "--output-format", "json", capture=True))
        state[key] = reply["id"]
        write_state(stage, state)
        print(f"Submitted {path.name}: {state[key]}", flush=True)
    submission = state[key]
    # Submission IDs survive interruption; rerunning never resubmits the same job.
    try:
        run("xcrun", "notarytool", "wait", submission, *auth, "--timeout", "30m")
    except subprocess.CalledProcessError:
        # A rejected submission still needs its diagnostic log. A timed-out
        # submission remains resumable using the persisted identifier.
        pass
    result = json.loads(run("xcrun", "notarytool", "info", submission, *auth,
                           "--output-format", "json", capture=True))
    if result.get("status") not in ("Accepted", "Invalid", "Rejected"):
        raise ValueError(f"Submission {submission} is {result.get('status')}; rerun notarize to resume")
    log_path = stage / f"{key}.json"
    run("xcrun", "notarytool", "log", submission, *auth, log_path)
    log = json.loads(log_path.read_text())
    if result.get("status") != "Accepted" or log.get("status") != "Accepted":
        raise ValueError(f"Notarization not accepted; inspect {log_path}")
    if log.get("issues"):
        raise ValueError(f"Review notarization warnings before distribution: {log_path}")
    run("xcrun", "stapler", "staple", path)
    run("xcrun", "stapler", "validate", path)


def verify_dmg_payload(dmg, state):
    with tempfile.TemporaryDirectory(prefix="bywave-verify-", dir="/private/tmp") as folder:
        run("hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", folder, dmg)
        try:
            app = Path(folder) / "ByWaveCalendar.app"
            validate_app(app, state["team"], state["architecture"])
            run("xcrun", "stapler", "validate", app)
            run("spctl", "--assess", "--type", "execute", "--verbose=2", app)
        finally:
            run("hdiutil", "detach", folder)


def package_notarized_app(app, dmg, stage, state):
    run(Path(state["javaHome"]) / "bin/jpackage", "--type", "dmg",
        "--name", "ByWaveCalendar", "--app-version", state["version"],
        "--vendor", "ByWave", "--app-image", app, "--dest", dmg.parent,
        "--resource-dir", DESKTOP / "packaging", "--mac-package-identifier", BUNDLE_ID)
    # JDK 21 jpackage re-signs an app-image ad hoc even if it was already
    # Developer ID signed. Keep its branded Finder layout, then restore the
    # immutable notarized app before sealing the image. Do not re-sign the app.
    editable = stage / "payload-editable.dmg"
    sealed = stage / "payload-sealed.dmg"
    editable.unlink(missing_ok=True)
    sealed.unlink(missing_ok=True)
    run("hdiutil", "convert", dmg, "-format", "UDRW", "-o", editable)
    with tempfile.TemporaryDirectory(prefix="bywave-package-", dir="/private/tmp") as folder:
        run("hdiutil", "attach", "-nobrowse", "-mountpoint", folder, editable)
        try:
            packaged_app = Path(folder) / app.name
            if packaged_app.is_symlink() or not packaged_app.is_dir():
                raise ValueError("Unexpected app-image layout in the locally generated DMG")
            shutil.rmtree(packaged_app)
            run("ditto", "--rsrc", "--extattr", app, packaged_app)
            validate_app(packaged_app, state["team"], state["architecture"])
            run("xcrun", "stapler", "validate", packaged_app)
        finally:
            run("hdiutil", "detach", folder)
    run("hdiutil", "convert", editable, "-format", "UDZO", "-o", sealed)
    sealed.replace(dmg)
    editable.unlink()
    sign(dmg, state["identity"])
    # Inspect the actual final container BEFORE submitting or distributing it.
    verify_dmg_payload(dmg, state)


def notarize(args):
    stage = Path(args.stage).resolve()
    state = json.loads((stage / "state.json").read_text())
    app = Path(state["app"])
    identity_check(state["identity"], state["team"])
    validate_app(app, state["team"], state["architecture"])
    archive = stage / "ByWaveCalendar.zip"
    if "appSubmission" not in state:
        run("ditto", "-c", "-k", "--keepParent", app, archive)
    # ZIPs cannot be stapled: submit the ZIP, staple its app bundle.
    if "appSubmission" not in state:
        reply = json.loads(run("xcrun", "notarytool", "submit", archive,
                               "--keychain-profile", args.keychain_profile,
                               "--output-format", "json", capture=True))
        state["appSubmission"] = reply["id"]
        write_state(stage, state)
        print(f"Submitted app: {state['appSubmission']}", flush=True)
    notarize_file(app, stage, state, "appSubmission", args.keychain_profile)
    run("spctl", "--assess", "--type", "execute", "--verbose=2", app)
    dmg_dir = stage / "dmg"
    dmg = dmg_dir / f"ByWaveCalendar-{state['version']}.dmg"
    if "dmgSubmission" not in state:
        dmg_dir.mkdir(exist_ok=True)
        dmg.unlink(missing_ok=True)
        package_notarized_app(app, dmg, stage, state)
    notarize_file(dmg, stage, state, "dmgSubmission", args.keychain_profile)
    run("codesign", "--verify", "--strict", "--verbose=2", dmg)
    run("hdiutil", "verify", dmg)
    run("spctl", "--assess", "--type", "open", "--context", "context:primary-signature", "-v", dmg)
    verify_dmg_payload(dmg, state)
    output = Path(args.output).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    architecture = "arm64" if state["architecture"] == "arm64" else "x64"
    name = f"ByWaveCalendar-{state['version']}-{architecture}-signed.dmg"
    destination = output / name
    digest = hashlib.sha256(dmg.read_bytes()).hexdigest()
    # Published URLs are immutable: never silently replace a different installer.
    if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest() != digest:
        raise ValueError(f"Refusing to overwrite an existing installer: {destination}")
    temporary = output / f".{name}.partial"
    shutil.copyfile(dmg, temporary)
    temporary.replace(destination)
    (output / f"{name}.sha256").write_text(f"{digest}  {name}\n")
    report = {**state, "filename": name, "sha256": digest,
              "sizeBytes": destination.stat().st_size, "status": "Accepted"}
    (output / f"{name}.verification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Verified, notarized installer: {destination}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build", help="Test, build and sign locally; no notarization")
    build_parser.add_argument("--identity", required=True, help="Developer ID certificate SHA-1 fingerprint")
    build_parser.add_argument("--team-id", required=True)
    build_parser.add_argument("--java-home", help="Full JDK 21; architecture determines the package")
    notary_parser = commands.add_parser("notarize", help="Resume notarization and verify the final DMG")
    notary_parser.add_argument("--stage", required=True)
    notary_parser.add_argument("--keychain-profile", required=True)
    notary_parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") == "true":
        parser.error("Run on a local Mac; GitHub Actions packaging is disabled")
    try:
        (build if args.command == "build" else notarize)(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Release stopped: {error}\n")


if __name__ == "__main__":
    main()
