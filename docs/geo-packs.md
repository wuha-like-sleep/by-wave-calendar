# 地址包（自建地址库）运营指南

地址联想（`/api/geo/suggest`）有三层：客户端本地地址簿 → 本站的地址
包 → 在线 Photon 兜底。地址包是本站自带的结构化地址库：一国一个
SQLite 文件，服务端直接查本地包给联想结果，不依赖任何外部服务；
包缺失、打不开或查不到时自动回落 Photon，行为与没有包时一致。

本文档面向**自托管运营者**：怎么给自己的实例装包、包的格式规格
（任何人都可以自产兼容包）、以及自产包时的数据来源与许可红线。

## 一、装包的三种方式

包目录只有一个解析入口：环境变量 `GEO_PACK_DIR` 优先，未设时是
进程工作目录下的 `data/geo-packs`。三种方式最终都把文件放进这个
目录，且都经过同一条「校验 → 原子落位」路径，provider 按文件
mtime 自动重开新包，不需要重启。

### 方式 1：后台一键获取官方包（推荐）

项目在 GitHub Releases 上发布官方地址包（当前为澳洲包
`geo-packs-au-v1`）。管理后台 →「地址包」→「获取官方地址包」点一
下即可：服务端拉取发布清单、逐文件下载（支持断点续传与失败重
试）、按清单里的 SHA-256 逐个复核、复核通过才原子落位激活；已
经是最新版的文件自动跳过。进度与结果在同一页可见，操作记审计。

发布源可配置：

| 环境变量 | 说明 |
|---|---|
| `GEO_PACK_RELEASE_BASE_URL` | 发布基地址（目录式前缀，其下有 `geo-pack-release.json` 与资产文件）。默认是本项目 GitHub Releases 的澳洲包发布；镜像到自己的静态站点后改指过去即可 |
| `GEO_PACK_RELEASE_ALLOW_PRIVATE_NETWORK` | 默认 `false`。仅当发布基地址指向内网镜像时才需要设为 `true`（与 `ICS_ALLOW_PRIVATE_NETWORK` 同性质的逃生口） |

### 方式 2：手动放文件

把包文件直接拷进包目录即可（文件名必须符合下文的命名规则）：
`pack-<id>.sqlite` 是包本体，`manifest-<id>.json` /
`licence-manifest-<id>.json` / `ATTRIBUTION-<id>.txt` 是它的配套文
件（后台清单页的行数、校验和与许可信息都取自它们，应当一并放
入）。放好后无需任何操作，provider 会在下一次查询时用上新包。

### 方式 3：同步通道推送（适合打包机定期产包）

打包机用仓库工具 [tools/geo-pack-sync](../tools/geo-pack-sync/) 把
包分片推送到实例：先在管理后台「地址包」页生成一枚**同步令牌**
（与个人 API Token、管理员会话完全独立，只存哈希、可随时吊销），
装到打包机上，然后运行：

```bash
python3 tools/geo-pack-sync/geo_pack_sync.py \
  --url https://your-instance.example.com \
  --packs-dir ./packs --token-file ./geo-sync-token
```

通道纪律：逐片 SHA-256 校验、断点续传、整文件复核通过才原子落
位、文件名白名单、全程审计。细节见该工具的 README。

## 二、包格式规格（自产兼容包）

### 2.1 目录与命名

服务端只认以下命名（同步通道、后台下载、一键获取共用同一套白
名单，不符合的名字一律拒绝）：

| 文件 | 说明 |
|---|---|
| `pack-<id>.sqlite` | 包本体，`<id>` 为小写字母/数字/连字符，如 `au`、`au-nsw` |
| `manifest-<id>.json` | 该包的清单（见 2.3） |
| `licence-manifest-<id>.json` | 该包的许可清单（每个数据源的许可与署名） |
| `ATTRIBUTION-<id>.txt` | 该包的署名全文 |
| `manifest.json` / `licence-manifest.json` / `ATTRIBUTION.txt` | 跨包共享版本（单包部署时用） |
| `licences/<name>.txt` | 许可全文（如 `odbl-1.0.txt`、`cc-by-4.0.txt`） |

一个目录可以放多个包：全国包 `pack-<country>.sqlite` 与分州/分
区包并存时，provider 优先用全国包，没有全国包则合并查所有分区包。

### 2.2 SQLite 结构（schema 1）

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
-- 必备键：pack_id（与文件名 id 一致）、country（如 AU）、
-- region、schema（"1"）、built_unix（构建时间戳）

CREATE TABLE addresses (
  cid INTEGER PRIMARY KEY,
  display TEXT,        -- 完整展示地址
  unit TEXT,           -- 单元/房号（可空）
  number TEXT,         -- 门牌号
  street_name TEXT, street_type TEXT,
  suburb TEXT, state TEXT, postcode TEXT,
  poi_name TEXT,       -- 地点/机构名（非住宅行）
  category TEXT,       -- 类别（如 railway=station），用于排序加权
  weight REAL,         -- 热度权重（知名度信号，越大越靠前）
  lat REAL, lon REAL,
  sources TEXT         -- 溯源标记（如 gnaf / gnaf,osm / geonames）
);

CREATE VIRTUAL TABLE addr_fts USING fts5(
  search_text, tokenize="unicode61 remove_diacritics 2");
CREATE VIRTUAL TABLE addr_tri USING fts5(
  search_text, tokenize="trigram");
```

`addr_fts` / `addr_tri` 的 rowid 与 `addresses.cid` 对齐；
`search_text` 是供检索的归一化文本（小写、去重音、含名称变体与缩
写别名、地址各段的拼接）。检索口径：先在 `addr_fts` 做全词前缀
AND 召回，再在 `addr_tri` 做三元组 OR 救援（容错拼写），最后在
服务端按名称匹配层级、类别显著度与 `weight` 综合排序；同一地址
的多个单元行会折叠成一行并带 `units[]` 返回。

落位前的服务端自检：文件头必须是 `SQLite format 3`，且
`meta.pack_id` 必须与文件名 id 一致——SHA 对得上但串了包也进不来。

### 2.3 manifest-<id>.json 字段

```json
{
  "pack_id": "au-nsw",
  "country": "AU",
  "region": "New South Wales, Australia",
  "pack_version": "2026.11.2",
  "build_date": "2026-11-20T09:17:33Z",
  "file": "pack-au-nsw.sqlite",
  "bytes": 3086860288,
  "sha256": "<整文件 SHA-256>",
  "rows_total": 5133392,
  "rows_by_provenance": { "gnaf": 4574543, "gnaf,osm": 366537 },
  "sources": [
    { "name": "…", "version": "…", "licence": "…", "attribution": "…" }
  ]
}
```

后台清单页与同步跳过判断都以这里的 `bytes` / `sha256` 为准。

### 2.4 发布格式（geo-pack-release.json）

一键获取的发布源是一个静态目录：

```
<base>/geo-pack-release.json     发布清单
<base>/<资产>                     清单列出的每个文件/分卷
```

```json
{
  "format": 1,
  "release": "geo-packs-au-v1",
  "generated_at": "2026-11-21T00:00:00Z",
  "packs": [
    {
      "pack_id": "au-nsw",
      "file": "pack-au-nsw.sqlite",
      "bytes": 3086860288,
      "sha256": "<整文件 SHA-256>",
      "rows_total": 5133392,
      "region": "New South Wales, Australia",
      "pack_version": "2026.11.2",
      "parts": [
        { "name": "pack-au-nsw.sqlite.part-000", "bytes": 1610612736, "sha256": "…" },
        { "name": "pack-au-nsw.sqlite.part-001", "bytes": 1476247552, "sha256": "…" }
      ],
      "companions": [
        { "name": "manifest-au-nsw.json", "bytes": 1106, "sha256": "…" },
        { "name": "licence-manifest-au-nsw.json", "bytes": 1451, "sha256": "…" },
        { "name": "attribution-au-nsw.txt", "bytes": 1151, "sha256": "…" }
      ]
    }
  ],
  "shared": [
    { "name": "licences/odbl-1.0.txt", "bytes": 0, "sha256": "…" }
  ]
}
```

分卷规则（为绕开 GitHub Release 单资产 2 GiB 上限）：

- 单资产 ≤ 2 GiB 的文件直接以最终文件名发布，`parts` 省略；
- 超限文件拆成 `<file>.part-000`、`.part-001`…顺序分卷，每卷
  ≤ 2 GiB，卷字节数之和必须等于整文件 `bytes`；
- 下载端逐卷验 SHA-256 后按序拼接，再验整文件 SHA-256，最后才
  原子落位——任何一步对不上，整包不落位；
- 清单里的每个名字都过 2.1 的白名单与路径包含校验，清单按不可
  信输入处理（即使发布源被篡改，也写不出包目录、覆盖不了别的文件）。

## 三、自产包的数据来源与许可红线

地址数据不是「网上能下就能用」。自产包必须逐个数据源核许可，
并把结论写进包的 `licence-manifest` 与署名文件：

- **只用官方开放渠道**（官方批量下载/开放数据门户），不爬取禁
  止抓取或禁止存储的来源；条款写明「可用不可再分发」的数据只
  能做参考比对，不得进包；
- **逐源记录**：处理、衍生再分发、商业使用、署名要求、share-alike
  传染范围、是否含个人数据，六项都要有结论再入库；
- 官方澳洲包的三个来源及其要点（自产其它国家时按同样标准逐源核）：
  - **G-NAF**（Geoscape Australia）：基于 CC BY 4.0 的 Open G-NAF
    EULA；**附加限制：不得用其生成用于邮寄的地址（除非另行二次
    核验）**——日历联想不涉及邮寄，但限制必须随包署名一同分发；
  - **OpenStreetMap**：ODbL 1.0，衍生数据库再分发必须同协议
    share-alike，并署名 © OpenStreetMap contributors；
  - **GeoNames**：CC BY 4.0，署名 GeoNames；
- 署名不是装饰：包内 `ATTRIBUTION` 与许可全文必须随包分发，
  产品内的《数据处理政策》页面也应包含地址数据的来源署名（本
  仓库已内置对应章节）。

## 四、Photon 回落与自建 Photon

没有包、包里查不到、或包打不开时，suggest 自动改查
`GEO_PROVIDER_BASE_URL` 指向的 Photon 兼容端点；显式设
`GEO_PROVIDER=photon` 可以完全关掉本地包。

默认端点 `https://photon.komoot.io` 是 Komoot 的**公共演示实例**：
适合试用，没有可用性承诺且有其用量政策，不应作为生产依赖。生
产自托管二选一：

1. **装官方包**（第一节方式 1），本地查询、零外部依赖；
2. **自建 Photon**：Photon 本身开源（photon.komoot.io 背后的同
   一套软件，基于 OSM 数据），用官方发布或容器镜像在自己的机
   器上跑一份，把 `GEO_PROVIDER_BASE_URL` 指过去即可，本站的代
   理、缓存与限流口径不变。

## 五、常见问题

- **后台看不到包**：确认文件在 `GEO_PACK_DIR` 解析出的目录里
  （后台页顶部有目录展示），且文件名符合 2.1 的命名规则。
- **获取任务失败**：先看后台页的失败码；`sha256_mismatch` 多半
  是发布源文件损坏或清单过期，重新获取会自动续传未完成部分。
- **改了包不生效**：provider 按 mtime 重开句柄，正常落位（rename）
  会自动生效；如果手工拷文件后没反应，检查拷入的是否是完整文
  件（拷贝中途的文件可能被读到半成品，建议先拷成临时名再改名）。
