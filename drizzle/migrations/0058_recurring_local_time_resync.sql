-- 让手机重新下载一遍「网页 / App 建的重复事件」。
--
-- 背景
-- ----
-- 1.7.4 把重复事件改成按事件自己的时区展开（src/lib/rrule_expand.ts + event_zone.ts）：
-- 以前 DTSTART 按 UTC 交给 rrule，「每周一」按 UTC 的周一算，墨尔本早上 11 点前、北京
-- 早上 8 点前的例会落到第二天，夏令时一切换整体挪一小时。
--
-- 导出给手机的那份也跟着改了（src/lib/ical.ts serializeEvent、web/caldav.ts rowToIcal）：
-- 没有 extra.timezone 的重复事件以前写的是 DTSTART:…Z，手机照 RFC 5545 也按 UTC 展开，
-- 错法和服务端以前一模一样；现在写成 DTSTART;TZID=<日历时区>，EXDATE 也写成同一时区的
-- 墙上时间。有 extra.timezone 的那些 DTSTART 本来就带 TZID，这一版变的是 EXDATE 的写法。
--
-- 代码改好了，但**已经同步到手机上的那份不会自己变**：CalDAV 的单条 etag 只喂 updated_at
-- （src/web/caldav.ts etagOf），这一版这些行一个字节都没动，客户端认为手上那份就是最新的。
--
-- 圈定范围（和 0056 同一个口径，换成「定时的重复事件」）
-- ------------------------------------------------------
--   · NOT all_day             —— 全天事件按 UTC 日期展开，这一版没变
--   · rrule 非空              —— 不重复的事件导出没变（单个时刻写成 UTC 是精确的）
--   · deleted_at IS NULL      —— 软删的事件不出现在 CalDAV 响应里
--   · raw_ics 里没有 VEVENT   —— 有原文的行 GET 时原样回放（rowToVCalendar →
--                                mergeExdatesIntoVevent），这一版一个字节都没改。
--                                那些行里被改写过「删掉这一次」的，由程序里的数据迁移
--                                （src/lib/data_migrations.ts）自己刷新 updated_at。
-- 有 extra.timezone、又没有 exdates 的行，输出其实没变，也会被 bump 到 —— 多下一次正文，
-- 换来不用在 SQL 里判「这个时区名 Node 认不认」。重复事件的数量远小于全部事件。
-- 升级前想先看看有多少行：
--   SELECT count(*) FROM events
--    WHERE NOT all_day AND rrule IS NOT NULL AND rrule <> '' AND deleted_at IS NULL
--      AND (raw_ics IS NULL OR strpos(raw_ics, 'BEGIN:VEVENT') = 0);
--
-- 为什么还要 bump 一次同步纪元
-- --------------------------
-- 同 0056：只改 updated_at 不够。ctag = md5(纪元 | 日历 | max(updated_at) | 活行数)，
-- 这里写的是一个固定的时刻，日历里只要有别的行比它新，ctag 就不变，苹果日历根本不来列，
-- 单条 etag 变了也没人看见。纪元只进 ctag、不进单条 etag：每个日历多列一次，只有这批
-- etag 变了的会被重下。
--
-- 为什么写死时间戳 / 字面量，而不是 now()
-- --------------------------------------
-- 同 0050 / 0051 / 0056：这条必须能重跑（auto_migrate.ts 每次开机跑迁移器，历史上出过记账
-- 对不上、整条链重放）。字面量 + `<>` / `IS DISTINCT FROM`：两次运行之间没人动过这批事件、
-- 也没人在后台按过「让所有设备重新同步」的话，第二遍匹配不到任何行，什么都不改。
-- 两次之间有变动时，第二遍只会让这几条多下载一次，不改事件内容。
-- 用 `<>` 不用 `<`：升级发生在这个时刻之后的任意一天，中间被编辑过的事件 updated_at
-- 已经比它大，可手机上那份照样可能是改之前抓的，不能漏。
--
-- 这个时刻**必须早于任何一次升级**（取的是打包前，墨尔本 10-29 零点）。写成未来的时刻，
-- 日历的 max(updated_at) 会被钉在那个时刻上：到点之前网页、App、手机的每一次修改都只把
-- updated_at 写成 now()，max 不变、活行数不变，ctag 就不变，苹果日历和 DAVx⁵ 不来拉，
-- 改动一直到不了手机上。test/integration/migration_recurring_local_time.int.test.ts 拦着。
--
-- 和程序里那条数据迁移的先后
-- ------------------------
-- 迁移器先跑完所有 SQL（包括这一条），再跑 data_migrations.ts。被那边改写了 exdates 的行，
-- updated_at 会再被刷新成当时的时刻（比这里的字面量新），etag 再变一次 —— 手机拿到的
-- 是改写之后的那份。
--
-- 副作用（逐个 grep 过 updated_at 的读者，结论同 0056）
-- ---------------------------------------------------
--   · CalDAV：这批事件的 etag 变了，手机重下一次正文。正好有一次拿旧 etag 的修改在路上的话，
--     会收到 412、重新拉一次再改 —— 标准行为。
--   · 三端 App / 网页：按日期窗口拉 /api/v1/events，展开结果由服务端算，升级后直接是对的；
--     updatedAt 只进了网页「这批数据变没变」的指纹，下一次拉取多重画一次。
--   · webhook：只由应用代码在 API 写操作里发，SQL 迁移不触发。
--   · 导出的 .ics 里 LAST-MODIFIED / DTSTAMP 会显示成下面这个时刻，不参与任何先后判断。

-- 语句一：bump 这批事件的 updated_at → 单条 etag 变。
UPDATE events
   SET updated_at = TIMESTAMPTZ '2026-10-28 13:00:00+00'
 WHERE NOT all_day
   AND rrule IS NOT NULL
   AND rrule <> ''
   AND deleted_at IS NULL
   AND (raw_ics IS NULL OR strpos(raw_ics, 'BEGIN:VEVENT') = 0)
   AND updated_at <> TIMESTAMPTZ '2026-10-28 13:00:00+00';--> statement-breakpoint

-- 语句二：bump 同步纪元 → 每个日历的 ctag 变，客户端来列。
-- 全新安装时 site_settings 那一行还不存在，匹配不到行，也不需要。
UPDATE site_settings
   SET caldav_sync_epoch = '2026-10-29-recurring-local-time'
 WHERE caldav_sync_epoch IS DISTINCT FROM '2026-10-29-recurring-local-time';
