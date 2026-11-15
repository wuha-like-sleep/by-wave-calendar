import importlib.util
from pathlib import Path
import tempfile
import unittest
import os
import hashlib
import json
from threading import Lock
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mirror', Path(__file__).with_name('mirror-release-to-gitee.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class MirrorSafetyTest(unittest.TestCase):
    def test_only_versioned_release_tags(self):
        for tag in ['../main', 'desktop-v1.3.1;echo bad', 'server-v1.9.0', 'android-v1.0.0\n']:
            with self.subTest(tag=tag), self.assertRaises(ValueError): m.validate_tag(tag)
        self.assertEqual(m.validate_tag('desktop-v1.3.1'), 'desktop-v1.3.1')
        self.assertEqual(m.validate_tag('v1.9.1'), 'v1.9.1')
        self.assertEqual(m.expected_names('v1.9.1'), {'by-wave-calendar-v1.9.1.tar.gz', 'by-wave-calendar-v1.9.1.tar.gz.sig', 'SHA256SUMS.txt'})

    def test_credential_cannot_inject_curl_configuration(self):
        for value in ['', 'token\nurl=https://example.test', 'token"', 'token\\']:
            with self.subTest(value=value), self.assertRaises(ValueError): m.token_config(value)

    def test_api_errors_show_provider_reason_without_tokens_or_log_injection(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"GH_TOKEN": "private-gh", "GITEE_RELEASE_TOKEN": "private/gitee+"}):
            response = Path(folder) / 'response.json'
            response.write_text(json.dumps({"message": "upload rejected\n::error::private-gh\x1b", "errors": {"file": ["storage limit private%2Fgitee%2B private/gitee+"]}, "access_token": "must-not-print"}))
            detail = m.api_error_detail(response)
            self.assertIn('storage limit', detail)
            for forbidden in ('private-gh', 'private/gitee+', 'private%2Fgitee%2B', 'must-not-print', '\n', '\x1b'):
                self.assertNotIn(forbidden, detail)
            self.assertIn('[redacted]', detail)

    def test_api_error_details_are_bounded_and_ignore_non_json_bodies(self):
        with tempfile.TemporaryDirectory() as folder:
            response = Path(folder) / 'response.json'
            for raw in ('<html>proxy error</html>', json.dumps(['unexpected']), 'x' * 8193):
                response.write_text(raw)
                self.assertEqual(m.api_error_detail(response), '')
            response.write_text(json.dumps({"message": "x" * 1000}))
            self.assertEqual(len(json.loads(m.api_error_detail(response))), 512)

    def test_checksums_require_every_asset_once(self):
        names = {'app.apk', 'latest.json', 'SHA256SUMS.txt'}
        valid = 'a' * 64 + '  app.apk\n' + 'b' * 64 + '  latest.json\n'
        self.assertEqual(set(m.parse_checksums(valid, names)), names - {'SHA256SUMS.txt'})
        for text in [valid.splitlines()[0], valid + valid.splitlines()[0], valid.replace('app.apk', '../app.apk'), valid.replace('a' * 64, 'invalid')]:
            with self.subTest(text=text), self.assertRaises(ValueError): m.parse_checksums(text, names)

    def test_private_repository_is_rejected_before_release_fetch(self):
        with patch.object(m, 'get', return_value={'private':True, 'full_name':m.GITHUB_REPO}) as get:
            with self.assertRaises(ValueError):m.mirror('desktop-v1.3.1')
            self.assertEqual(get.call_count, 1)

    def test_prerelease_cannot_be_published_to_gitee(self):
        with patch.object(m, 'get', side_effect=[{'private':False,'full_name':m.GITHUB_REPO},{'tag_name':'android-v0.13.1','draft':False,'prerelease':True}]) as get, patch.object(m, 'api') as api:
            with self.assertRaises(ValueError):m.mirror('android-v0.13.1')
            api.assert_not_called()

    def test_unexpected_release_asset_prevents_any_gitee_write(self):
        release={'tag_name':'android-v0.13.1','draft':False,'prerelease':False,'assets':[{'name':'../secret'}]}
        with patch.object(m,'get',side_effect=[{'private':False,'full_name':m.GITHUB_REPO},release]),patch.object(m,'api') as api:
            with self.assertRaises(ValueError):m.mirror('android-v0.13.1')
            api.assert_not_called()

    def test_download_size_and_checksum_are_both_enforced(self):
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'asset';target.write_bytes(b'installer')
            with patch.object(m.subprocess,'run') as run:
                run.return_value.returncode=0
                with self.assertRaises(ValueError):m.download('https://example.test/file',target,10)
                with self.assertRaises(ValueError):m.download('https://example.test/file',target,9,'0'*64)
                self.assertEqual(len(m.download('https://example.test/file',target,9)),64)

    def test_downloads_never_accept_plain_http_or_embedded_credentials(self):
        with patch.object(m.subprocess,'run') as run:
            for url in ['http://example.test/file','https://name:password@example.test/file']:
                with self.assertRaises(ValueError):m.download(url,Path('/tmp/unused'),1)
            run.assert_not_called()

    def test_gitee_limit_requires_complete_compact_pair(self):
        tag = 'desktop-v1.3.1'
        assets = {name: {'size': 100} for name in m.expected_names(tag)}
        original = 'ByWaveCalendar-1.3.1-arm64-signed.dmg'
        assets[original]['size'] = m.GITEE_ASSET_LIMIT + 1
        with self.assertRaises(ValueError): m.select_mirror_names(tag, assets)
        compact = 'ByWaveCalendar-1.3.1-arm64-compact-signed.dmg'
        assets[compact] = {'size': m.GITEE_ASSET_LIMIT}
        with self.assertRaises(ValueError): m.select_mirror_names(tag, assets)
        assets['SHA256SUMS-compact.txt'] = {'size': 100}
        selected = m.select_mirror_names(tag, assets)
        self.assertNotIn(original, selected)
        self.assertIn(compact, selected)
        assets[compact]['size'] += 1
        with self.assertRaises(ValueError): m.select_mirror_names(tag, assets)

    def test_compact_checksums_only_cover_declared_variant(self):
        names = m.compact_names('desktop-v1.3.1')
        name = 'ByWaveCalendar-1.3.1-arm64-compact-signed.dmg'
        text = 'a' * 64 + '  ' + name + '\n'
        self.assertEqual(m.parse_checksums(text, names, 'SHA256SUMS-compact.txt'), {name: 'a' * 64})
        with self.assertRaises(ValueError):
            m.parse_checksums(text.replace('-compact', ''), names, 'SHA256SUMS-compact.txt')

    def test_dns_override_keeps_tls_host_and_rejects_local_addresses(self):
        for address in ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'evil.test', '180.76.198.225\nurl=https://evil.test']:
            with self.subTest(address=address), patch.dict(os.environ, {'GITEE_RESOLVE_IPV4': address}), self.assertRaises(ValueError):
                m.gitee_connection_options()
        with patch.dict(os.environ, {'GITEE_RESOLVE_IPV4': '180.76.198.225'}):
            self.assertEqual(m.gitee_connection_options(), ['--resolve', 'gitee.com:443:180.76.198.225'])

    def test_stable_publication_requires_every_parallel_download_to_verify(self):
        tag = 'android-v0.13.1'
        payloads = {'bywave-calendar-0.13.1.apk': b'installer',
                    'latest.json': json.dumps({'versionName': '0.13.1'}).encode()}
        payloads['SHA256SUMS.txt'] = ''.join(hashlib.sha256(data).hexdigest() + '  ' + name + '\n'
                                          for name, data in payloads.items()).encode()
        prefix = f'https://github.com/{m.GITHUB_REPO}/releases/download/{tag}/'
        release = {'tag_name': tag, 'draft': False, 'prerelease': False, 'name': 'Android', 'body': 'Notes',
                   'assets': [{'name': name, 'size': len(data), 'browser_download_url': prefix + name}
                              for name, data in payloads.items()]}
        for corrupt in (False, True):
            with self.subTest(corrupt=corrupt):
                uploaded, verified, destinations = {}, set(), set()
                lock = Lock()
                published = []

                def api(service, method, path, data=None, file=None):
                    if service == 'github':
                        if path == '': return {'private': False, 'full_name': m.GITHUB_REPO}
                        if path.startswith('/releases/tags/'): return release
                        return {'object': {'type': 'commit', 'sha': 'a' * 40}}
                    if path == '/releases?per_page=100': return []
                    if path == '/releases': return {'id': 1}
                    with lock:
                        if method == 'POST':
                            self.assertNotIn(file.name, uploaded)
                            uploaded[file.name] = {'name': file.name, 'size': file.stat().st_size,
                                                   'browser_download_url': 'https://gitee.com/' + file.name}
                            return uploaded[file.name]
                        if method == 'PATCH':
                            self.assertEqual(verified, set(payloads))
                            published.append(data)
                            return {}
                        return list(uploaded.values())

                def download(url, target, size, checksum=None):
                    name = url.rsplit('/', 1)[1]
                    data = payloads[name]
                    is_gitee = url.startswith('https://gitee.com/')
                    if is_gitee:
                        with lock:
                            self.assertNotIn(str(target), destinations)
                            destinations.add(str(target))
                        if corrupt and name.endswith('.apk'): data += b'corruption'
                    target.write_bytes(data)
                    digest = hashlib.sha256(data).hexdigest()
                    if len(data) != size or (checksum and digest != checksum):
                        raise ValueError('Downloaded attachment failed verification')
                    if is_gitee:
                        with lock: verified.add(name)
                    return digest

                with patch.object(m, 'api', side_effect=api), patch.object(m, 'download', side_effect=download):
                    if corrupt:
                        with self.assertRaises(ValueError): m.mirror(tag)
                        self.assertEqual(published, [])
                    else:
                        m.mirror(tag)
                        self.assertEqual(len(published), 1)
                        self.assertIs(published[0]['prerelease'], False)

if __name__=='__main__': unittest.main()
