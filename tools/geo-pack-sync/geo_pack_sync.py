#!/usr/bin/env python3
"""geo_pack_sync.py — 把地址包从打包机推到 ByWave 服务器（地址包同步通道）。

这是仓库内的官方版本，任何自托管者/打包者都可以用：把自产的地址包
（格式见 docs/geo-packs.md）从打包机推送到自己的 ByWave 实例。协议
（服务端见仓库 src/routes/geo_sync.ts）：
  1. GET  /api/geo-sync/packs            已激活包清单（file → sha256）
  2. POST /api/geo-sync/uploads          以 manifest 开会话（或找回可续传会话）
  3. PUT  /api/geo-sync/uploads/:id/chunks/:n   逐片上传（片头带片 SHA-256）
  4. POST /api/geo-sync/uploads/:id/complete    服务端整体复核 SHA-256 后原子落位

纪律：
  - 鉴权只用同步令牌（bwgs_…），从令牌文件读（令牌由管理员在后台
    「地址包」页生成；令牌文件权限应为 600，脚本发现权限过宽会告警）。
  - 单连接、串行传片，不并发——打包机上通常还有别的活，同步让路。
  - 每个包先传配套文件（manifest / licence-manifest / ATTRIBUTION），
    sqlite 最后传：sqlite 落位即激活，激活时配套必须已就位。
  - 服务端已激活且 SHA-256 与本地一致 → 整包跳过（--force 强制重传）。
  - 中断（断网 / Ctrl-C / 进程被杀）后重跑本脚本即续传：服务端按
    (file, sha256, bytes) 找回原会话，只补未确认的分片。

用法：
  python3 geo_pack_sync.py --url https://your-instance.example.com \
      --packs-dir ./packs --token-file ./geo-sync-token \
      [--packs au-tas,au-nt] [--national] [--force] [--chunk-mib 8]
      [--chunk-kib N]           # 覆盖 --chunk-mib（KiB 粒度，前置 WAF/代理有请求体上限时用）
      [--stop-after-chunks N]   # 测试用：传 N 片后主动停下

环境变量可代替常用参数：BYWAVE_SYNC_URL / BYWAVE_SYNC_TOKEN_FILE。
--url 没有默认值（没有「作者的服务器」这种东西），必须显式给出你
自己的实例地址。退出码：0 = 全部成功或跳过；2 = 有包失败 / 参数缺
失；3 = 被 --stop-after-chunks 停下。
"""
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

# 官方 AU 发布包的默认集合（与 GitHub Releases 上的 geo-packs-au-v2
# 一致）。自产其它国家/地区包时用 --packs 显式给出自己的包 id 列表。
STATE_PACKS = ["au-nsw", "au-vic", "au-qld", "au-wa", "au-sa", "au-tas", "au-act", "au-nt", "au-ot"]


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


class SyncClient:
    def __init__(self, base_url, token):
        self.base = base_url.rstrip("/")
        self.token = token

    def request(self, method, path, body=None, headers=None, raw=False):
        url = self.base + path
        hdrs = {"Authorization": f"Bearer {self.token}"}
        if headers:
            hdrs.update(headers)
        data = body
        if body is not None and not raw:
            data = json.dumps(body).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        last_err = None
        for attempt in range(5):
            req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
            try:
                with urllib.request.urlopen(req, timeout=180) as resp:
                    payload = resp.read()
                    return resp.status, json.loads(payload) if payload else {}
            except urllib.error.HTTPError as e:
                payload = e.read()
                try:
                    detail = json.loads(payload) if payload else {}
                except json.JSONDecodeError:
                    detail = {"error": payload[:200].decode("utf-8", "replace")}
                if e.code < 500:
                    return e.code, detail
                last_err = f"HTTP {e.code} {detail}"
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                last_err = str(e)
            if attempt < 4:
                time.sleep(2 ** attempt)
        raise RuntimeError(f"{method} {path} failed after retries: {last_err}")


class StopEarly(Exception):
    pass


def upload_file(client, packs_dir, name, chunk_bytes, meta=None, stop_after=None, counter=None):
    """传一个文件（会话 → 分片 → 完成）。返回服务端最终状态字符串。"""
    full = os.path.join(packs_dir, name)
    size = os.path.getsize(full)
    digest = sha256_file(full)
    manifest = {"file": name, "bytes": size, "sha256": digest, "chunkSize": chunk_bytes}
    if meta:
        manifest.update(meta)
    status, session = client.request("POST", "/api/geo-sync/uploads", manifest)
    if status != 201:
        raise RuntimeError(f"open session for {name}: HTTP {status} {session}")
    if session.get("chunkSize") != chunk_bytes:
        # 找回的旧会话分片计划与本次要求不一致（例如旧会话是大分片、
        # 而本次因服务器前置 WAF/代理的请求体上限必须用小分片）：
        # 中止旧会话并以本次分片大小重开，否则会永远按旧计划续传。
        client.request("DELETE", f"/api/geo-sync/uploads/{session['uploadId']}")
        status, session = client.request("POST", "/api/geo-sync/uploads", manifest)
        if status != 201:
            raise RuntimeError(f"reopen session for {name}: HTTP {status} {session}")
    upload_id = session["uploadId"]
    chunk_size = session["chunkSize"]
    total = session["chunkCount"]
    received = set(session.get("receivedChunks", []))
    if received:
        print(f"    resume {name}: {len(received)}/{total} chunks already on server")
    with open(full, "rb") as f:
        for index in range(total):
            if index in received:
                continue
            f.seek(index * chunk_size)
            data = f.read(chunk_size)
            chunk_sha = hashlib.sha256(data).hexdigest()
            status, view = client.request(
                "PUT",
                f"/api/geo-sync/uploads/{upload_id}/chunks/{index}",
                body=data,
                headers={"Content-Type": "application/octet-stream", "X-Chunk-SHA256": chunk_sha},
                raw=True,
            )
            if status != 200:
                raise RuntimeError(f"chunk {index} of {name}: HTTP {status} {view}")
            if counter is not None:
                counter[0] += 1
                if stop_after and counter[0] >= stop_after:
                    raise StopEarly(f"stopped after {counter[0]} chunks (test aid)")
            if total > 8 and (index + 1) % 4 == 0:
                print(f"    {name}: {index + 1}/{total} chunks")
    status, result = client.request("POST", f"/api/geo-sync/uploads/{upload_id}/complete")
    if status != 200:
        raise RuntimeError(f"complete {name}: HTTP {status} {result}")
    return result.get("status", "active")


def companions_of(pack_id):
    return [f"manifest-{pack_id}.json", f"licence-manifest-{pack_id}.json", f"ATTRIBUTION-{pack_id}.txt"]


def sync_pack(client, packs_dir, pack_id, chunk_bytes, force, server_packs, stop_after, counter):
    manifest_path = os.path.join(packs_dir, f"manifest-{pack_id}.json")
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    pack_file = manifest["file"]
    local_sha = manifest["sha256"]
    active = server_packs.get(pack_file)
    if not force and active and active.get("sha256") == local_sha:
        print(f"  {pack_id}: already active (sha256 match), skipped")
        return "skipped"
    meta = {
        "rows": manifest.get("rows_total"),
        "region": manifest.get("region"),
        "packVersion": manifest.get("pack_version"),
    }
    for name in companions_of(pack_id):
        if os.path.exists(os.path.join(packs_dir, name)):
            upload_file(client, packs_dir, name, chunk_bytes)
            print(f"    companion {name} ok")
    upload_file(client, packs_dir, pack_file, chunk_bytes, meta=meta,
                stop_after=stop_after, counter=counter)
    print(f"  {pack_id}: ACTIVATED ({manifest.get('rows_total')} rows, sha256 {local_sha[:12]}…)")
    return "activated"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Sync address packs from DGX to a ByWave server")
    ap.add_argument("--url", default=os.environ.get("BYWAVE_SYNC_URL"), help="your ByWave instance base URL (required)")
    ap.add_argument("--token-file", default=os.environ.get("BYWAVE_SYNC_TOKEN_FILE", "geo-sync-token"))
    ap.add_argument("--packs-dir", default="packs")
    ap.add_argument("--packs", default=",".join(STATE_PACKS), help="comma-separated pack ids")
    ap.add_argument("--national", action="store_true", help="also sync the national pack (pack-au.sqlite, ~9.5 GiB)")
    ap.add_argument("--force", action="store_true", help="re-upload even if the server sha matches")
    ap.add_argument("--chunk-mib", type=int, default=8)
    ap.add_argument("--chunk-kib", type=int, default=0, help="chunk size in KiB (overrides --chunk-mib; for servers behind a WAF/proxy with a small request-body limit)")
    ap.add_argument("--stop-after-chunks", type=int, default=0, help="test aid: stop after N pack chunks")
    args = ap.parse_args(argv)

    if not args.url:
        print("missing --url (or BYWAVE_SYNC_URL): pass your own ByWave instance base URL.", file=sys.stderr)
        return 2
    try:
        mode = os.stat(args.token_file).st_mode
        if mode & 0o077:
            print(f"warning: token file {args.token_file} is readable by group/other; chmod 600 recommended.", file=sys.stderr)
    except OSError:
        pass

    try:
        with open(args.token_file, encoding="utf-8") as f:
            token = f.read().strip()
    except OSError as e:
        print(f"cannot read sync token file {args.token_file}: {e}", file=sys.stderr)
        print("create one in the admin backend (Address packs → Sync tokens) and save it there with mode 600.", file=sys.stderr)
        return 2
    if not token.startswith("bwgs_"):
        print(f"token file {args.token_file} does not hold a bwgs_ sync token", file=sys.stderr)
        return 2

    client = SyncClient(args.url, token)
    status, listing = client.request("GET", "/api/geo-sync/packs")
    if status != 200:
        print(f"cannot list server packs: HTTP {status} {listing}", file=sys.stderr)
        return 2
    server_packs = {p["file"]: p for p in listing.get("packs", [])}
    print(f"server {args.url}: {len(server_packs)} active pack(s)")

    chunk_bytes = args.chunk_kib * 1024 if args.chunk_kib else max(1, args.chunk_mib) * 1024 * 1024
    counter = [0]
    results = {}

    # 共享文件先行（许可全文与顶层归属），都很小。
    shared = ["ATTRIBUTION.txt", "licence-manifest.json"]
    licences_dir = os.path.join(args.packs_dir, "licences")
    if os.path.isdir(licences_dir):
        shared += [f"licences/{n}" for n in sorted(os.listdir(licences_dir)) if n.endswith(".txt")]
    if args.national:
        shared.append("manifest.json")
    for name in shared:
        if os.path.exists(os.path.join(args.packs_dir, name)):
            upload_file(client, args.packs_dir, name, chunk_bytes)
            print(f"  shared {name} ok")

    pack_ids = [p.strip() for p in args.packs.split(",") if p.strip()]
    if args.national:
        pack_ids.append("au")
    failed = False
    for pack_id in pack_ids:
        try:
            results[pack_id] = sync_pack(
                client, args.packs_dir, pack_id, chunk_bytes, args.force,
                server_packs, args.stop_after_chunks or None, counter,
            )
        except StopEarly as e:
            print(f"  {pack_id}: {e}")
            return 3
        except Exception as e:  # 单个包失败不挡后面的包，最后统一报
            print(f"  {pack_id}: FAILED — {e}")
            results[pack_id] = "failed"
            failed = True
    print("summary:", ", ".join(f"{k}={v}" for k, v in results.items()))
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
