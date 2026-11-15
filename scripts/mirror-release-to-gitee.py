#!/usr/bin/env python3
"""Mirror already published, checksum-verified installers; never compile code."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import tarfile
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.parse import quote, quote_plus, urlsplit

GITHUB_REPO = "wuha-like-sleep/by-wave-calendar"
GITEE_REPO = "zhaorunsen/by-wave-calendar"
GITEE_ASSET_LIMIT = 100 * 1024 * 1024


def gitee_connection_options():
    # Optional DNS override for an unreachable CDN edge. The destination remains
    # gitee.com, with normal TLS hostname/certificate validation and no redirects
    # on authenticated API requests. Never accept a private or arbitrary host.
    address = os.environ.get("GITEE_RESOLVE_IPV4", "")
    if not address:
        return []
    ip = ipaddress.ip_address(address)
    if ip.version != 4 or not ip.is_global:
        raise ValueError("Gitee address override must be a public IPv4 address")
    return ["--resolve", f"gitee.com:443:{ip}"]


def validate_tag(tag):
    if not re.fullmatch(r"(?:(?:desktop|android)-)?v[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise ValueError("Expected a published desktop-vX.Y.Z, android-vX.Y.Z or vX.Y.Z tag")
    return tag


def token_config(token):
    if not token or any(c in token for c in '\r\n"\\'):
        raise ValueError("Release credential missing or invalid")
    return 'header = "Authorization: Bearer ' + token + '"\n'


def api_error_detail(response):
    """Show bounded provider diagnostics without echoing arbitrary bodies or tokens."""
    try:
        with response.open("rb") as stream:
            raw = stream.read(8193)
        if len(raw) > 8192:
            return ""
        payload = json.loads(raw)
    except (OSError, ValueError):
        return ""
    if not isinstance(payload, dict):
        return ""
    allowed = {"message", "error", "error_description", "errors", "detail", "file", "base", "code"}
    def messages(value, depth=0):
        if depth > 3:
            return []
        if isinstance(value, str):
            return [value]
        if isinstance(value, list):
            return [text for item in value[:4] for text in messages(item, depth + 1)]
        if isinstance(value, dict):
            return [text for key, item in value.items() if key in allowed for text in messages(item, depth + 1)]
        return []
    detail = "; ".join(messages(payload))
    for key in ("GH_TOKEN", "GITEE_RELEASE_TOKEN"):
        secret = os.environ.get(key, "")
        if secret:
            for form in {secret, quote(secret, safe=""), quote_plus(secret)}:
                detail = detail.replace(form, "[redacted]")
    # JSON escaping prevents multiline/ANSI/workflow-command log injection.
    return json.dumps(detail[:512], ensure_ascii=True) if detail else ""


def api(service, method, path, data=None, file=None):
    host, repo, key = ("api.github.com", GITHUB_REPO, "GH_TOKEN") if service == "github" else ("gitee.com/api/v5", GITEE_REPO, "GITEE_RELEASE_TOKEN")
    with tempfile.TemporaryDirectory(prefix="bywave-api-") as temp:
        response = Path(temp) / "response.json"
        args = ["curl", "--progress-bar" if file else "--silent", "--show-error", "--connect-timeout", "20", "--max-time", "10800" if file else "90", "--config", "-", "--request", method, "--output", str(response), "--write-out", "%{http_code}", f"https://{host}/repos/{repo}{path}"]
        if service == "gitee":
            args += gitee_connection_options()
        if data is not None:
            body = Path(temp) / "body.json"
            body.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            args += ["--header", "Content-Type: application/json", "--data-binary", "@" + str(body)]
        if file:
            args += ["--form", "file=@" + str(file)]
        result = subprocess.run(args, input=token_config(os.environ.get(key, "")), text=True,
                                stdout=subprocess.PIPE, stderr=None if file else subprocess.PIPE)
        if result.returncode or not result.stdout.isdigit() or not 200 <= int(result.stdout) < 300:
            detail = api_error_detail(response)
            raise RuntimeError(f"{service} {method} failed (curl {result.returncode}, HTTP {result.stdout[:3]})"
                               + (f"; provider detail={detail}" if detail else ""))
        return json.loads(response.read_text(encoding="utf-8"))


def get(service, path):
    for attempt in range(4):
        try:
            return api(service, "GET", path)
        except RuntimeError:
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))


def download(url, target, size, checksum=None):
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.username or parts.password:
        raise ValueError("Only public HTTPS download URLs are allowed")
    result = subprocess.run(["curl", "--silent", "--show-error", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "20", "--max-time", "1800", "--retry", "3", "--max-filesize", str(size), "--output", str(target), *gitee_connection_options(), url])
    if result.returncode or target.stat().st_size != size:
        raise ValueError("Download failed or its size does not match the published asset")
    with target.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if checksum and actual != checksum:
        raise ValueError("Downloaded asset checksum does not match")
    return actual


def expected_names(tag):
    version = tag.rsplit("v", 1)[1]
    if tag.startswith("desktop-"):
        return {f"ByWaveCalendar-{version}-arm64-signed.dmg", f"ByWaveCalendar-{version}-x64-signed.dmg", f"ByWaveCalendar-{version}-x64.msi", "latest.json", "SHA256SUMS.txt"}
    if tag.startswith("android-"):
        return {f"bywave-calendar-{version}.apk", "latest.json", "SHA256SUMS.txt"}
    return {f"by-wave-calendar-v{version}.tar.gz", f"by-wave-calendar-v{version}.tar.gz.sig", "SHA256SUMS.txt"}


def compact_names(tag):
    if not tag.startswith("desktop-"):
        return set()
    return {f"ByWaveCalendar-{tag.rsplit('v', 1)[1]}-arm64-compact-signed.dmg", "SHA256SUMS-compact.txt"}


def select_mirror_names(tag, assets):
    canonical, compact = expected_names(tag), compact_names(tag)
    names = set(assets)
    if names != canonical and (not compact or names != canonical | compact):
        raise ValueError("Unexpected or missing GitHub assets")
    if compact and compact <= names:
        names.remove(f"ByWaveCalendar-{tag.rsplit('v', 1)[1]}-arm64-signed.dmg")
    if any(not 0 < assets[name]["size"] <= GITEE_ASSET_LIMIT for name in names):
        raise ValueError("Gitee attachment exceeds 100 MiB; prepare a smaller local installer before publishing")
    return names


def parse_checksums(text, names, checksum_name="SHA256SUMS.txt"):
    checksums = {}
    for line in text.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9_.-]+)", line)
        if not match or match[2] in checksums:
            raise ValueError("Malformed or duplicate checksum entry")
        checksums[match[2]] = match[1]
    if set(checksums) != names - {checksum_name}:
        raise ValueError("Every release file must have exactly one checksum")
    return checksums


def mirror(tag, check_only=False):
    validate_tag(tag)
    repo = get("github", "")
    if repo.get("private") is not False or repo.get("full_name") != GITHUB_REPO:
        raise ValueError("Only the named public repository may use this transfer workflow")
    release = get("github", "/releases/tags/" + quote(tag, safe=""))
    if release.get("draft") or release.get("prerelease") or release.get("tag_name") != tag:
        raise ValueError("Only a published stable release may be mirrored")
    assets = {a["name"]: a for a in release["assets"]}
    names = expected_names(tag)
    if len(assets) != len(release["assets"]):
        raise ValueError("Duplicate GitHub assets")
    mirror_names = select_mirror_names(tag, assets)
    prefix = f"https://github.com/{GITHUB_REPO}/releases/download/{tag}/"
    for name, asset in assets.items():
        if asset["browser_download_url"] != prefix + quote(name) or not 0 < asset["size"] <= 500_000_000:
            raise ValueError("Unexpected GitHub asset URL or size")
    ref = get("github", "/git/ref/tags/" + quote(tag, safe=""))["object"]
    if ref["type"] == "tag":
        ref = get("github", "/git/tags/" + ref["sha"])["object"]
    if ref["type"] != "commit" or not re.fullmatch(r"[0-9a-f]{40}", ref["sha"]):
        raise ValueError("Release tag does not resolve to one source commit")
    with tempfile.TemporaryDirectory(prefix="bywave-mirror-") as temp:
        folder = Path(temp)
        sums = assets["SHA256SUMS.txt"]
        digest = sums.get("digest")
        checksum = digest[7:] if digest and digest.startswith("sha256:") else None
        sums_hash = download(sums["browser_download_url"], folder / sums["name"], sums["size"], checksum)
        checksums = parse_checksums((folder / sums["name"]).read_text(), names)
        compact = compact_names(tag)
        if compact and compact <= set(assets):
            extra_sums = assets["SHA256SUMS-compact.txt"]
            digest = extra_sums.get("digest") or ""
            extra_hash = download(extra_sums["browser_download_url"], folder / extra_sums["name"], extra_sums["size"], digest[7:] if digest.startswith("sha256:") else None)
            checksums.update(parse_checksums((folder / extra_sums["name"]).read_text(), compact, "SHA256SUMS-compact.txt"))
            checksums["SHA256SUMS-compact.txt"] = extra_hash
        for name in sorted(checksums):
            download(assets[name]["browser_download_url"], folder / name, assets[name]["size"], checksums[name])
        version = tag.rsplit("v", 1)[1]
        if tag.startswith("v"):
            archive = folder / f"by-wave-calendar-v{version}.tar.gz"
            with tarfile.open(archive) as tar:
                package = tar.extractfile(f"by-wave-calendar-v{version}/package.json")
                if package is None or json.load(package).get("version") != version:
                    raise ValueError("Server package does not match the release tag")
            signature = base64.b64decode(Path(str(archive) + ".sig").read_text().strip(), validate=True)
            if len(signature) != 64:
                raise ValueError("Invalid server package signature")
            sigfile = folder / "signature.bin"
            sigfile.write_bytes(signature)
            key = Path(__file__).resolve().parents[1] / "deploy/update-signing-pub.pem"
            subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(key), "-rawin", "-in", str(archive), "-sigfile", str(sigfile)], check=True)
        else:
            manifest = json.loads((folder / "latest.json").read_text())
            if manifest.get("versionName") != version:
                raise ValueError("Update manifest does not match the release tag")
        checksums["SHA256SUMS.txt"] = sums_hash
        print(f"Verified {len(assets)} published files for {tag}", flush=True)
        if check_only:
            return
        body = {"tag_name": tag, "name": release["name"], "body": release["body"], "target_commitish": ref["sha"], "prerelease": True}
        for attempt in range(4):
            existing = get("gitee", "/releases?per_page=100")
            match = next((r for r in existing if r["tag_name"] == tag), None)
            if match is not None:
                break
            try:
                match = api("gitee", "POST", "/releases", body)
                break
            except RuntimeError:
                if attempt == 3:
                    raise
                # A timed-out create may have succeeded; query by tag before
                # sending another POST. Never overwrite another release.
                time.sleep(10 * (attempt + 1))
        release_path = "/releases/" + str(int(match["id"]))
        def transfer_one(name):
            items = get("gitee", release_path + "/attach_files")
            matches = [a for a in items if a["name"] == name]
            if len(matches) > 1:
                raise ValueError("Duplicate Gitee attachment; refusing to replace files")
            if not matches:
                # A timed-out POST may have succeeded. A later run rechecks the
                # remote attachment before retrying; never delete/overwrite it.
                print(f"Uploading Gitee attachment: {name} ({assets[name]['size']} bytes)", flush=True)
                api("gitee", "POST", release_path + "/attach_files", file=folder / name)
                items = get("gitee", release_path + "/attach_files")
                matches = [a for a in items if a["name"] == name]
            if len(matches) != 1 or matches[0]["size"] != assets[name]["size"]:
                raise ValueError("Gitee attachment size mismatch or incomplete upload")
            download(matches[0]["browser_download_url"], folder / ("verify-" + name), assets[name]["size"], checksums[name])
            print(f"Verified Gitee attachment: {name}", flush=True)
        # Distinct attachments can transfer independently. The workflow's tag
        # concurrency lock prevents two runs from uploading the same filename.
        # Wait for every transfer; any failure prevents stable publication.
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(transfer_one, sorted(mirror_names)))
        api("gitee", "PATCH", release_path, {"tag_name": tag, "name": release["name"], "body": release["body"], "prerelease": False})
        print(f"Published Gitee release: {tag}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("--check-only", action="store_true", help="Verify public GitHub files without any Gitee write")
    args = parser.parse_args()
    try:
        mirror(args.tag, args.check_only)
    except (ValueError, RuntimeError, OSError, KeyError) as exc:
        parser.exit(1, f"Release transfer stopped: {exc}\n")
