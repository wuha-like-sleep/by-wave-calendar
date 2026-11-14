#!/usr/bin/env python3
"""Build an explicitly unsigned Windows test MSI locally without changing OS policies."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile


def pe_machine(path):
    with Path(path).open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise ValueError(f"Not a PE binary: {path}")
        stream.seek(0x3C)
        offset = struct.unpack("<I", stream.read(4))[0]
        stream.seek(offset)
        if stream.read(4) != b"PE\x00\x00":
            raise ValueError(f"Invalid PE header: {path}")
        return struct.unpack("<H", stream.read(2))[0]


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def signature_status(path):
    literal = "'" + str(path).replace("'", "''") + "'"
    code = f"(Get-AuthenticodeSignature -LiteralPath {literal}).Status.ToString()"
    encoded = base64.b64encode(code.encode("utf-16-le")).decode("ascii")
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    return subprocess.check_output([str(powershell), "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                                   text=True).strip()


def build(args):
    if sys.platform != "win32" or os.environ.get("GITHUB_ACTIONS") == "true":
        raise ValueError("Run on a local Windows computer; cloud packaging is disabled")
    if not args.unsigned_test_package:
        raise ValueError("This workflow creates unsigned local test packages only; pass --unsigned-test-package")
    java, wix = Path(args.java_home).resolve(), Path(args.wix_home).resolve()
    for tool in [java / "bin/java.exe", java / "bin/jpackage.exe", wix / "candle.exe", wix / "light.exe", wix / "dark.exe"]:
        if not tool.is_file():
            raise ValueError(f"Required tool missing: {tool}")
    if pe_machine(java / "bin/java.exe") != 0x8664:
        raise ValueError("Use a full x64 JDK 21")
    version_output = subprocess.run([str(java / "bin/java.exe"), "-version"], check=True,
                                    text=True, capture_output=True).stderr
    if not re.search(r'version "21[.\"]', version_output):
        raise ValueError("Use JDK 21")
    repo = Path(__file__).resolve().parents[1]
    source = repo / "apps/desktop"
    match = re.search(r'^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"',
                      (source / "build.gradle.kts").read_text(encoding="utf-8"), re.MULTILINE)
    if not match:
        raise ValueError("Desktop version is missing")
    version = match[1]
    stage = Path(tempfile.mkdtemp(prefix="bywave-build-"))
    project = stage / "desktop"
    # UNC/shared/iCloud locations are unsuitable for jpackage and Gradle's native tools.
    shutil.copytree(source, project, ignore=shutil.ignore_patterns("build", ".gradle", ".kotlin", ".idea", ".DS_Store"))
    print(f"Build directory: {project}", flush=True)
    env = os.environ.copy()
    env["JAVA_HOME"] = str(java)
    env["PATH"] = os.pathsep.join([str(java / "bin"), str(wix), env["PATH"]])
    env["GRADLE_USER_HOME"] = str(Path(env["LOCALAPPDATA"]) / "ByWaveBuildTools/gradle")
    subprocess.run([str(project / "gradlew.bat"), "test", "packageBrandedMsi", "--no-daemon"],
                   cwd=project, env=env, check=True, stderr=subprocess.STDOUT)
    app = project / "build/compose/binaries/main/app/ByWaveCalendar"
    for binary in [app / "ByWaveCalendar.exe", app / "runtime/bin/server/jvm.dll"]:
        if pe_machine(binary) != 0x8664:
            raise ValueError(f"Wrong native architecture: {binary}")
    msi = project / f"build/compose/binaries/main/msi/ByWaveCalendar-{version}.msi"
    if msi.stat().st_size < 1_000_000:
        raise ValueError("Installer is unexpectedly small")
    # Verify the MSI itself: merely placing bitmaps in --resource-dir does not
    # make jpackage/WiX embed them. Keep an extraction log for packaging failures.
    extracted = stage / "msi-resources"
    with (stage / "msi-resources.log").open("wb") as log:
        subprocess.run([str(wix / "dark.exe"), "-nologo", "-x", str(extracted), str(msi),
                        "-o", str(stage / "installer.wxs")], check=True, stdout=log, stderr=subprocess.STDOUT)
    for resource, source_name in [("WixUI_Bmp_Banner", "WinBanner.bmp"), ("WixUI_Bmp_Dialog", "WinDialog.bmp")]:
        matches = list(extracted.rglob(resource))
        if len(matches) != 1 or digest(matches[0]) != digest(project / "packaging" / source_name):
            raise ValueError(f"MSI is missing the expected branded image: {resource}")
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    name = f"ByWaveCalendar-{version}-local-test-x64.msi"
    destination = out / name
    sha256 = digest(msi)
    if destination.exists() and digest(destination) != sha256:
        raise ValueError("Output exists with different contents; choose a fresh output directory")
    temporary = out / f".{name}.partial"
    shutil.copyfile(msi, temporary)
    temporary.replace(destination)
    (out / f"{name}.sha256").write_text(f"{sha256}  {name}\n", encoding="ascii")
    report = {"mode": "unsigned-local-test", "brandingVerified": True, "version": version, "architecture": "x64",
              "sourceRevision": args.source_revision, "filename": name, "sha256": sha256,
              "sizeBytes": destination.stat().st_size, "signatureStatus": signature_status(destination),
              "applicationImage": str(app), "testResults": str(project / "build/test-results/test")}
    (out / f"{name}.verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Local test installer: {destination}\nApplication image: {app}", flush=True)
    print("Unsigned test package. Keep published release assets and update manifests unchanged.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--java-home", required=True)
    parser.add_argument("--wix-home", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--unsigned-test-package", action="store_true")
    parser.add_argument("--source-revision", default="working-tree")
    args = parser.parse_args()
    try:
        build(args)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Local packaging stopped: {error}\n")


if __name__ == "__main__":
    main()
