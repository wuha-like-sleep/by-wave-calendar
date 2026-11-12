"""Offline safety checks for local release packaging; no credentials required."""
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("release_macos", Path(__file__).with_name("release-macos.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseSafetyTests(unittest.TestCase):
    def test_invalid_packaged_signature_fails_preflight_and_detaches_image(self):
        calls = []
        with patch.object(release, "run", side_effect=lambda *a, **k: calls.append(a)), \
                patch.object(release, "validate_app", side_effect=ValueError("ad hoc signature")):
            with self.assertRaisesRegex(ValueError, "ad hoc signature"):
                release.verify_dmg_payload(Path("installer.dmg"), {"team": "TEAM", "architecture": "arm64"})
        self.assertEqual(calls[0][:2], ("hdiutil", "attach"))
        self.assertEqual(calls[-1][:2], ("hdiutil", "detach"))
        self.assertFalse(any("notarytool" in c for c in calls))

    def test_rejects_disabled_library_validation_even_with_valid_signature(self):
        with tempfile.TemporaryDirectory() as folder:
            app = Path(folder) / "App.app"
            (app / "Contents").mkdir(parents=True)
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": release.BUNDLE_ID}))
            entitlements = {
                "com.apple.security.cs.allow-jit": True,
                "com.apple.security.cs.allow-unsigned-executable-memory": True,
                "com.apple.security.cs.disable-library-validation": True,
            }
            results = [SimpleNamespace(stderr="TeamIdentifier=TEAM\nflags=runtime\nTimestamp=now"),
                       SimpleNamespace(stdout=plistlib.dumps(entitlements))]
            with patch.object(release, "run", return_value="arm64"), \
                    patch.object(release.subprocess, "run", side_effect=results):
                with self.assertRaisesRegex(ValueError, "Unexpected application entitlements"):
                    release.validate_app(app, "TEAM", "arm64")

    def test_rejects_wrong_runtime_architecture(self):
        with tempfile.TemporaryDirectory() as folder:
            app = Path(folder) / "App.app"
            (app / "Contents").mkdir(parents=True)
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": release.BUNDLE_ID}))
            with patch.object(release, "run", side_effect=["arm64", "x86_64"]):
                with self.assertRaisesRegex(ValueError, "Wrong native architecture"):
                    release.validate_app(app, "TEAM", "arm64")

    def test_rejects_ambiguous_name_and_development_identity(self):
        with self.assertRaises(ValueError):
            release.identity_check("Developer ID Application: Example", "TEAM")
        fingerprint = "A" * 40
        with patch.object(release, "run", return_value=f'{fingerprint} "Apple Development: Example (TEAM)"'):
            with self.assertRaises(ValueError):
                release.identity_check(fingerprint, "TEAM")

    def test_updates_embedded_native_checksum_without_extracting_entry_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            jar = Path(folder) / "native.jar"
            name = "../../outside.dylib"
            original = bytes.fromhex("cffaedfe") + b"native"
            with zipfile.ZipFile(jar, "w") as z:
                z.writestr(name, original)
                z.writestr(name + ".sha256", "old")
                z.writestr("resource.txt", "unchanged")

            def sign(path, identity):
                self.assertTrue(path.name.startswith("library-"))
                path.write_bytes(path.read_bytes() + b"signed")

            with patch.object(release, "sign", side_effect=sign):
                release.sign_jar(jar, "fingerprint")
            with zipfile.ZipFile(jar) as z:
                self.assertEqual(z.read(name), original + b"signed")
                self.assertEqual(z.read(name + ".sha256").decode(), hashlib.sha256(z.read(name)).hexdigest())
                self.assertEqual(z.read("resource.txt"), b"unchanged")

    def test_refuses_to_break_jar_signatures(self):
        with tempfile.TemporaryDirectory() as folder:
            jar = Path(folder) / "signed.jar"
            with zipfile.ZipFile(jar, "w") as z:
                z.writestr("native.dylib", bytes.fromhex("cffaedfe"))
                z.writestr("META-INF/VENDOR.SF", "signature")
            before = jar.read_bytes()
            with self.assertRaises(ValueError):
                release.sign_jar(jar, "fingerprint")
            self.assertEqual(jar.read_bytes(), before)

    def notarization(self, status, issues=None):
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            state = {"appSubmission": "existing-submission"}
            commands = []

            def fake_run(*args, **kwargs):
                commands.append(args)
                if args[:3] == ("xcrun", "notarytool", "info"):
                    return json.dumps({"status": status})
                if args[:3] == ("xcrun", "notarytool", "log"):
                    Path(args[-1]).write_text(json.dumps({"status": status, "issues": issues}))

            with patch.object(release, "run", side_effect=fake_run):
                if status != "Accepted" or issues:
                    with self.assertRaises(ValueError):
                        release.notarize_file(stage / "App.app", stage, state, "appSubmission", "profile")
                else:
                    release.notarize_file(stage / "App.app", stage, state, "appSubmission", "profile")
            self.assertFalse(any("submit" in c for c in commands))
            self.assertEqual(any("staple" in c for c in commands), status == "Accepted" and not issues)

    def test_resumes_accepted_submission_without_duplicate_upload(self):
        self.notarization("Accepted")

    def test_rejection_blocks_distribution(self):
        self.notarization("Invalid", [{"severity": "error"}])

    def test_warnings_block_distribution_pending_review(self):
        self.notarization("Accepted", [{"severity": "warning"}])

    def test_pending_submission_remains_resumable(self):
        self.notarization("In Progress")


if __name__ == "__main__":
    unittest.main()
