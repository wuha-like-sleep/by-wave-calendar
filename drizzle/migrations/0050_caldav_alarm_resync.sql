-- 逼 CalDAV 客户端把「带提醒的合成事件」重新拉一遍。
--
-- 背景
-- ----
-- 这一版有两处改动改变了同一批事件在 CalDAV 上的样子：
--   1) 合成出来的 VEVENT（网页 / API 建的事件，raw_ics 里没有 VEVENT 可回放）
--      现在会带 VALARM 了（src/lib/ical.ts serializeEvent）。
--   2) 0049 改写了一部分全天事件的 trigger。
--
-- 问题在于这两处都只改代码和 extra，**不改 updated_at、也不改行数**。而
-- src/web/caldav.ts 里 etag = hash(updated_at)、ctag = hash(max(updated_at)|行数)
-- —— 两个都没变，客户端就认为自己手上那份是新的，永远不会重新拉。
--
-- 后果不是「手机上少显示一个闹钟」那么轻。PUT 那边现在的口径是「整份 VEVENT
-- 传上来、里面没有 VALARM 就是用户把提醒删了」（带 If-Match 命中当前 etag 时生效）。
-- 客户端手上那份是部署前的、不带 VALARM 的副本，它的 If-Match 用的正是当前 etag，
-- 于是用户在手机上随手拖一下这个事件，网页设的提醒就被判成「用户删了」清掉。
-- 所以这一条不是优化，是 0049 那条口径能成立的前提。
--
-- 圈定范围
-- --------
-- 只有**合成路径**的事件序列化结果变了。raw_ics 里有 VEVENT 的行走的是原文回放
-- （src/web/caldav.ts rowToVCalendar），这一版一个字节都没改，把它们也 bump 一遍
-- 就是让每台手机白白重下整个日历。所以三个条件：
--   · deleted_at IS NULL      —— 软删的事件根本不出现在 CalDAV 响应里
--   · raw_ics 里没有 VEVENT   —— 只有这批走合成路径
--   · extra.alarms 是非空数组 —— 只有挂了提醒的事件序列化结果才变了
-- 量级：别把它想小了。网页新建事件时提醒下拉是**有默认值**的
-- （src/public/calendar-app.js 的 REMINDER_DEFAULTS），所以「在网页上建的、
-- 没被手动改成不提醒的事件」基本上都挂着一条提醒 —— 这一条实际会 bump 掉
-- 差不多全部网页/App 建的活事件。CalDAV / 导入进来的那批被 raw_ics 条件挡在外面。
-- 升级前想先看看有多少行，跑这个：
--   SELECT count(*) FROM events
--    WHERE deleted_at IS NULL
--      AND (raw_ics IS NULL OR strpos(raw_ics, 'BEGIN:VEVENT') = 0)
--      AND jsonb_typeof(extra -> 'alarms') = 'array'
--      AND jsonb_array_length(extra -> 'alarms') > 0;
-- 客户端那边看到的是「这些条目的 etag 变了」，做的是一次针对性的 multiget，
-- 不是把整个日历重建一遍（本仓库没有实现 sync-collection，客户端本来每轮就会
-- PROPFIND 取回全部 etag 做比对，这一步不产生额外的往返，只是多下了一批正文）。
-- 缩不了范围：能不能少 bump 一条，取决于「那台客户端手上的副本是什么时候抓的」，
-- 而服务端没有这个信息。宁可多下一次正文，也不要让用户在手机上碰一下事件
-- 就把网页设的提醒清掉。
--
-- 为什么写死一个时间戳，而不是 now()
-- ----------------------------------
-- 这条迁移必须可以重跑（src/lib/auto_migrate.ts 每次开机都跑迁移器，而历史上
-- 出现过记账和真实 schema 对不上、整条链重放的情况）。写 now() 的话第二遍会把
-- 所有行再 bump 一次，每台客户端再白拉一轮，而且「跑两遍结果一致」这条根本没法断言。
-- 写死成一个常量 + `updated_at <> 那个常量` 的条件之后，第二遍匹配不到任何行，
-- 是真正的 no-op。
-- 用 `<>` 而不是 `<`：升级发生在这个常量之后的任意时刻，中间被编辑过的事件
-- （updated_at 已经大于常量）手上的缓存同样是部署前那份，用 `<` 会把它们漏掉。
-- 代价是这批行的 updated_at 会往回走一点。这一列全仓库只喂三个地方 ——
-- etag、ctag、.ics 的 LAST-MODIFIED（已 grep 确认，不参与提醒调度、不在任何
-- 页面上显示、也没有 sync-token 依赖它单调递增），往回走只会让客户端重新拉，
-- 不会让任何判断出错。
UPDATE events
   SET updated_at = TIMESTAMPTZ '2026-09-21 02:00:00+00'
 WHERE deleted_at IS NULL
   AND (raw_ics IS NULL OR strpos(raw_ics, 'BEGIN:VEVENT') = 0)
   AND jsonb_typeof(extra) = 'object'
   AND jsonb_typeof(extra -> 'alarms') = 'array'
   AND jsonb_array_length(extra -> 'alarms') > 0
   AND updated_at <> TIMESTAMPTZ '2026-09-21 02:00:00+00';
