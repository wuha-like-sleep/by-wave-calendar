# geo_pack_sync.py — 地址包同步工具

把地址包从打包机推送到一个 ByWave 实例的同步通道（`POST /api/geo-sync/…`）。
这是仓库内的官方版本，任何自托管者或打包者都可以用；包的格式规格见
[docs/geo-packs.md](../../docs/geo-packs.md)。

## 前置条件

1. 目标实例已启用地址包（默认 `GEO_PROVIDER=pack` 即可）。
2. 在目标实例的管理后台「地址包」页生成一枚**同步令牌**，把明文存成
   一个文件（权限 600），例如 `./geo-sync-token`。令牌只显示一次；
   丢失就吊销后重建。
3. 本地有一个包目录，里面是按规格产出的文件：每个包一份
   `pack-<id>.sqlite` + `manifest-<id>.json` + `licence-manifest-<id>.json`
   + `ATTRIBUTION-<id>.txt`（配套文件缺失时跳过该文件，只传存在的）。

## 用法

```bash
python3 geo_pack_sync.py \
  --url https://your-instance.example.com \
  --packs-dir ./packs \
  --token-file ./geo-sync-token
```

| 参数 | 说明 |
|---|---|
| `--url` | 你的 ByWave 实例基地址。**必填**（或环境变量 `BYWAVE_SYNC_URL`），没有默认值 |
| `--token-file` | 同步令牌文件（或 `BYWAVE_SYNC_TOKEN_FILE`），默认 `./geo-sync-token` |
| `--packs-dir` | 本地包目录，默认 `./packs` |
| `--packs` | 逗号分隔的包 id 列表，默认是官方 AU 发布包的 9 个州包 |
| `--national` | 额外同步全国包 `pack-au.sqlite` 与顶层共享文件 |
| `--force` | 服务端 SHA 已一致也强制重传 |
| `--chunk-mib` | 分片大小（MiB），默认 8 |
| `--chunk-kib` | 分片大小（KiB），覆盖 `--chunk-mib`；服务器前置 WAF/代理有请求体上限时用小分片。若找回的旧会话分片大小与本次要求不一致，脚本会先中止旧会话再按新大小重开 |
| `--stop-after-chunks N` | 测试用：传 N 片后主动停下（退出码 3） |

行为：服务端已激活且 SHA-256 一致的包整包跳过；中断后重跑自动续传
（服务端按 文件+SHA+字节数 找回原会话，只补未确认的分片）；每个包先
传配套文件、sqlite 最后传（落位即激活）。退出码：0 全部成功/跳过，
2 有包失败或参数缺失，3 被 `--stop-after-chunks` 停下。

## 与作者部署的关系

项目作者自己的打包机（DGX）上保留着一份工作副本（`s8_sync.py`），
默认值指向作者自己的实例与目录，方便他日常使用；**本目录的版本是
canonical 的**——默认值全部通用化，两边协议一致、可以互换使用。以
后协议演进以仓库版为准。
