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
`geo-packs-au-v2`）。管理后台 →「地址包」→「获取官方地址包」点一
下即可：服务端拉取发布清单、逐文件下载、按清单里的 SHA-256 逐
个复核、复核通过才原子落位激活；已经是最新版的文件自动跳过。
进度与结果在同一页可见，操作记审计。

自 pack_version 2026.11.4（v2 发布）起，许可全文与署名不再作为
独立资产随发布分发，而是**内嵌在每个包文件自身**（sqlite `meta`
表，见 2.2）：包走到哪，许可跟到哪，不会散失；后台「地址包」页
会直接从包内读出许可清单与署名全文展示。发布清单的 `shared` 里
因此不再有 `licences/*` 条目（该字段本身仍是可选的）。

下载是按「烂网络也能最终下完」设计的（跨国链路、被中间设备周期
性掐断的长连接都算在内）：

- **小的先下**：共享文件之后，按包体积从小到大下载——小包先进
  服务，大包在后面慢慢磨；
- **停滞超时，不是总时长超时**：连续约 60 秒收不到任何字节才中
  止本次尝试，慢连接只要还在传数据就不会被掐断；
- **断点续传 + 无限退避重试**：连接重置、超时、服务端 5xx / 429
  这类瞬时错误一律退避后用 Range 续传（5 秒起、60 秒封顶），已
  下载的字节跨尝试、跨任务、跨进程重启都保留，文件终将下完；
  只有 404 等 4xx、完整下载后 SHA-256 对不上这类硬失败才会把
  单个文件判为失败（不拖累其他文件）；
- **重启自动恢复**：获取进行中服务重启（部署、崩溃），开机后会
  自动恢复未完成的任务接着下，后台页会标注「服务重启后已自动
  恢复」。后台页同时展示每个文件的状态（等待 / 下载中 / 重试中
  及次数 / 已激活 / 失败）和任务最近一次错误。

发布源可配置：

| 环境变量 | 说明 |
|---|---|
| `GEO_PACK_RELEASE_BASE_URL` | 发布基地址（目录式前缀，其下有 `geo-pack-release.json` 与资产文件）。默认是本项目 GitHub Releases 的澳洲包发布；镜像到自己的静态站点后改指过去即可 |
| `GEO_PACK_RELEASE_ALLOW_PRIVATE_NETWORK` | 默认 `false`。仅当发布基地址指向内网镜像时才需要设为 `true`（与 `ICS_ALLOW_PRIVATE_NETWORK` 同性质的逃生口） |

点获取之前可以先点同区块的「查看可获取的包」：服务端只拉发布清
单本身（小文件），把每个包的大小、行数、是否已安装和**总下载量**
先列出来，确认了再开始下载，不会点下去才发现要传几个 GiB。

#### 官方澳洲包大小一览

下表为 v1 发布（pack_version 2026.11.3）的实测值，取自该发布的
`geo-pack-release.json`（字节数为清单里的精确值）。v2
（2026.11.4）数据内容与 v1 逐行相同，仅每包多内嵌了许可与署名
文本（约 +57 KB/包），精确字节以 v2 发布清单为准：

| 文件 | 行数 | 精确字节 | 大小 | 分卷 |
|---|---:|---:|---:|:---:|
| pack-au-act.sqlite | 294,439 | 132,349,952 | 126.2 MiB | — |
| pack-au-nsw.sqlite | 5,133,392 | 2,320,072,704 | 2.16 GiB | 2 卷 |
| pack-au-nt.sqlite | 123,433 | 52,641,792 | 50.2 MiB | — |
| pack-au-ot.sqlite | 5,174 | 2,637,824 | 2.5 MiB | — |
| pack-au-qld.sqlite | 3,474,437 | 1,606,647,808 | 1.50 GiB | — |
| pack-au-sa.sqlite | 1,292,374 | 575,602,688 | 548.9 MiB | — |
| pack-au-tas.sqlite | 386,491 | 169,345,024 | 161.5 MiB | — |
| pack-au-vic.sqlite | 4,510,693 | 2,032,222,208 | 1.89 GiB | — |
| pack-au-wa.sqlite | 1,680,494 | 720,240,640 | 686.8 MiB | — |
| **合计（9 个包）** | **16,900,927** | **7,611,760,640** | **≈ 7.09 GiB** | |

全套总下载量：包本体 7,611,760,640 B，加上每包 3 个配套文件
（manifest / licence-manifest / ATTRIBUTION，共 33,804 B）与共享
文件（顶层 manifest、许可全文等，共 60,988 B），合计
**7,611,855,432 B ≈ 7.09 GiB**。已经装过的同版本文件会自动跳
过，实际下载量以预检显示的「本次需下载」为准。磁盘上请按整包大
小预留空间，分卷包拼接时还需要一份同大小的临时空间。

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

服务端只认以下命名（同步通道、一键获取共用同一套白名单，
不符合的名字一律拒绝）。包文件只进不出：本站不提供把包文件
下载到本地的入口，管理员只能把包获取到服务器。

| 文件 | 说明 |
|---|---|
| `pack-<id>.sqlite` | 包本体，`<id>` 为小写字母/数字/连字符，如 `au`、`au-nsw` |
| `manifest-<id>.json` | 该包的清单（见 2.3） |
| `licence-manifest-<id>.json` | 该包的许可清单（每个数据源的许可与署名） |
| `ATTRIBUTION-<id>.txt` | 该包的署名全文 |
| `manifest.json` / `licence-manifest.json` / `ATTRIBUTION.txt` | 跨包共享版本（单包部署时用） |
| `licences/<name>.txt` | 许可全文（如 `odbl-1.0.txt`、`cc-by-4.0.txt`）；手动放文件/同步通道仍可用此布局，官方发布自 2026.11.4 起改走包内嵌（2.2），不再附独立许可资产 |

一个目录可以放多个包：全国包 `pack-<country>.sqlite` 与分州/分
区包并存时，provider 优先用全国包，没有全国包则合并查所有分区包。

### 2.2 SQLite 结构（schema 2）

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
-- 必备键：pack_id（与文件名 id 一致）、country（如 AU）、
-- region、schema（"2"）、built_unix（构建时间戳）
-- 可选键（许可内嵌，官方包自 pack_version 2026.11.4 起携带）：
-- attribution（署名全文，纯文本）、licence_manifest（许可清单
-- JSON 字符串，形状同 licence-manifest-<id>.json）、licences
-- （许可全文 JSON 对象 {"odbl-1.0.txt": "<全文>", …}）

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

-- 检索文本只存一份，两张 FTS 表都是它的 external-content 视图
CREATE TABLE search_texts (cid INTEGER PRIMARY KEY, search_text TEXT);
CREATE VIRTUAL TABLE addr_fts USING fts5(
  search_text, content=search_texts, content_rowid=cid,
  tokenize="unicode61 remove_diacritics 2", columnsize=0);
CREATE VIRTUAL TABLE addr_tri USING fts5(
  search_text, content=search_texts, content_rowid=cid,
  tokenize="trigram");
```

`addr_fts` / `addr_tri` 的 rowid 与 `addresses.cid` 对齐；
`search_text` 是供检索的归一化文本（小写、去重音、含名称变体与缩
写别名、地址各段的拼接）。检索口径：先在 `addr_fts` 做全词前缀
AND 召回，再在 `addr_tri` 做三元组 OR 救援（容错拼写），最后在
服务端按名称匹配层级、类别显著度与 `weight` 综合排序；同一地址
的多个单元行会折叠成一行并带 `units[]` 返回。

schema 2 相对 schema 1 的体积优化（数据内容逐行不变，官方 AU 包
实测整体约小 25%，且经金门禁逐格比对与 schema 1 结果一致）：

- `search_text` 只在 `search_texts` 里存一份（schema 1 在两张 FTS
  表里各存一份）；两张 FTS 改为 external-content 指向它。
- `addr_fts` 加 `columnsize=0`，不存每列长度统计。
- `addresses` 上不再建 suburb / postcode 索引：检索只走 FTS，这
  两列只是结果载荷，索引纯占体积。
- 整库建议 `page_size = 16384` 建库并在收尾 `VACUUM` 重整。

兼容性：provider 只要求 `addresses` / `addr_fts` / `addr_tri` 三
张表存在并按 rowid=cid 对齐读取，schema 1 的旧包同样可读；
schema 2 是新的推荐产出格式。

内嵌许可三键（`attribution` / `licence_manifest` / `licences`）
全部可选、互相独立：没有它们的包（schema 1/2 旧包、自产包）照
常工作，后台「地址包」页读不到内嵌数据时回落到配套文件
（`ATTRIBUTION-<id>.txt` 等）的展示；带内嵌的包则以后台从包内
读出的许可清单与署名全文为准。自产包若要携带内嵌许可，三个键
的语义与配套文件一一对应：`attribution` 的内容就是
`ATTRIBUTION-<id>.txt` 的全文，`licence_manifest` 是
`licence-manifest-<id>.json` 的原文，`licences` 把
`licences/` 目录下每个全文按文件名收进一个 JSON 对象。

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
  "release": "geo-packs-au-v2",
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
    { "name": "ATTRIBUTION.txt", "bytes": 1151, "sha256": "…" }
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
- `shared` 可选、可为空：官方包自 2026.11.4 起许可全文内嵌在包
  内（见 2.2），`shared` 不再列 `licences/*` 独立资产；获取端不
  依赖任何 `shared` 条目存在。

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
- 署名不是装饰：`ATTRIBUTION` 与许可全文必须随包分发——官方包
  的做法是把它们内嵌进包文件自身的 `meta`（见 2.2），文件走到
  哪署名跟到哪；用配套文件分发时同理必须齐全。产品内的《数据
  处理政策》页面也应包含地址数据的来源署名（本仓库已内置对应
  章节）。

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
- **获取一直显示「重试中」**：这是在与不稳定的网络搏斗（常见于
  服务器到 GitHub 的跨国链路），不是卡死——已下载进度不会丢，
  网络恢复后会自动续完；想确认它在动，看该文件的字节数是否在
  涨、任务的「最近错误」是什么。实在长期不行，把发布资产镜像
  到离服务器近的静态站点，再改 `GEO_PACK_RELEASE_BASE_URL` 指
  过去。
- **改了包不生效**：provider 按 mtime 重开句柄，正常落位（rename）
  会自动生效；如果手工拷文件后没反应，检查拷入的是否是完整文
  件（拷贝中途的文件可能被读到半成品，建议先拷成临时名再改名）。
