-- 全天事件提醒档位改写：把老网页下拉存下来的定时档位翻译成全天档位。
--
-- 背景
-- ----
-- 上一轮把全天事件的提醒锚点改成了「事件所在时区当天 00:00 加减偏移」
-- （src/lib/reminder_triggers.ts 的 resolveAllDay）。iPhone 那种 -PT15H
-- 是照这个口径写的，改完终于对了（上海 17:00 → 09:00）。
--
-- 但网页老下拉给全天事件存的是**定时事件的档位**
-- （-PT5M / -PT15M / -PT30M / -PT1H / -PT2H / -P1D），新口径把它们算成了
-- 「当天 00:00 往前几分钟」= 前一晚。实测：
--
--   时区                  trigger    旧（UTC 午夜 + 偏移）  新（当地 00:00 + 偏移）
--   Asia/Shanghai         -PT15M     当天 07:45             前一晚 23:45
--   Australia/Melbourne   -PT15M     当天 09:45             前一晚 23:45
--   America/Los_Angeles   -PT15M     前一天 16:45           前一晚 23:45
--
-- 也就是说这批用户从「当天早上收到」变成了「前一晚睡前收到」，而且他们
-- 什么都没改。光靠代码修不了：-PT15M 在新口径里就是前一晚 23:45，这是
-- 对的；错的是这个值当初根本不该被存到全天事件上。只能改数据。
--
-- 翻译表：把「用户当初在下拉里选的那句话」翻成新口径里最接近的一档
-- ----------------------------------------------------------------
--   -PT0M / -PT5M / -PT15M / -PT30M / -PT1H / -PT2H  →  PT9H       当天 09:00
--   -P1D                                             →  -PT15H     前一天 09:00
--   -P1W                                             →  -P6DT15H   一周前 09:00
--
-- 前六档在旧口径里都落在「事件当天的清晨」（UTC+ 时区）或「前一天下午」
-- （UTC- 时区）—— 唯一在所有时区都成立的共同意思是「这一天到了，提醒我」，
-- 新口径里表达这句话的就是 PT9H。-P1D / -P1W 的「提前一天 / 提前一周」
-- 语义本身没问题，只是钟点从 08:00（UTC 午夜在东八区的投影）挪到 09:00，
-- 这正是新档位的定义。
-- 目标值全部取自 ALLDAY_TRIGGERS，一个字不差 —— 对不上的话网页下拉会认不出
-- 自己刚写进去的值，显示成「自定义：…」。
--
-- 为什么只动 raw_ics 里没有 VEVENT 的行
-- ------------------------------------
-- CalDAV / 导入进来的事件，GET 回放的是 raw_ics 原文（src/web/caldav.ts
-- rowToVCalendar），客户端手上那条 VALARM 是它自己写的、也由它自己显示。
-- 改 extra.alarms 只会让服务端发的提醒和手机上显示的时间对不上，而且客户端
-- 下次 PUT 会原样写回来。老网页下拉写出来的事件恰恰是「没有 raw_ics 可回放」
-- 的那一批（网页 PATCH 还会主动把 raw_ics 置 null，见 src/routes/events.ts），
-- 所以这个条件正好圈住了要修的人群。
--
-- 为什么只动未来的
-- ----------------
-- trigger 原文是幂等键 (event_id, trigger, instance_start) 的一部分
-- （src/db/schema.ts reminders_sent）。改了 trigger，已经发过的那条对不上旧行，
-- 就会重发。已经过去的事件重发一遍没有任何价值，只有骚扰，所以：
--   · 非重复事件：starts_at > now() 才改
--   · 重复事件（rrule IS NOT NULL）：全部改 —— 它们的未来实例还在
-- 重复事件在切换当天可能多响一次，见下面第一条语句。

-- 语句一：把「旧 trigger 已经发过」这件事记到新 trigger 名下，压掉换档当天的重复提醒。
--
-- 场景：明天的全天事件挂 -P1D，旧口径今天 08:00（东八区）已经响过并写了一行
-- reminders_sent。改成 -PT15H 之后新口径算出来是今天 09:00 —— 还没到，幂等键
-- 又是新的，于是同一个事件同一天响第二次。
-- 这里按 (event_id, new_trigger, instance_start) 补一行「已发」，那一响就被
-- 正常的幂等判定挡掉。补的是**已经发生过的那个实例**，未来实例的键不一样，
-- 一条都不会被误压。
-- sent_at 沿用旧行的，不写 now()：这一列的意思是「什么时候发出去的」。
-- 多条旧档位映射到同一个新档位时（-PT5M 和 -PT15M 都 → PT9H）取最近的一条，
-- DISTINCT ON 保证一次 INSERT 内部不会自己撞自己。
WITH scope AS MATERIALIZED (
  SELECT ev.id
    FROM events ev
   WHERE ev.all_day
     AND ev.deleted_at IS NULL
     AND jsonb_typeof(ev.extra) = 'object'
     AND jsonb_typeof(ev.extra -> 'alarms') = 'array'
     AND (ev.raw_ics IS NULL OR strpos(ev.raw_ics, 'BEGIN:VEVENT') = 0)
     AND (ev.rrule IS NOT NULL OR ev.starts_at > now())
),
mapping (old_trigger, new_trigger) AS (
  VALUES ('-PT0M', 'PT9H'),
         ('-PT5M', 'PT9H'),
         ('-PT15M', 'PT9H'),
         ('-PT30M', 'PT9H'),
         ('-PT1H', 'PT9H'),
         ('-PT2H', 'PT9H'),
         ('-P1D', '-PT15H'),
         ('-P1W', '-P6DT15H')
)
INSERT INTO reminders_sent (event_id, trigger, instance_start, sent_at)
SELECT DISTINCT ON (rs.event_id, m.new_trigger, rs.instance_start)
       rs.event_id, m.new_trigger, rs.instance_start, rs.sent_at
  FROM reminders_sent rs
  JOIN scope s ON s.id = rs.event_id
  JOIN mapping m ON m.old_trigger = rs.trigger
 ORDER BY rs.event_id, m.new_trigger, rs.instance_start, rs.sent_at DESC
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 语句二：真正的改写。
--
-- 可重入：源值和目标值两个集合不相交（PT9H / -PT15H / -P6DT15H 都不在
-- mapping 的左列里），第二遍跑 HAVING 那一层就没有任何行满足「这次真改了点什么」，
-- 一行都不会被 UPDATE 到。
--
-- 去重：-PT5M 和 -PT15M 同时挂在一个事件上时，改完两条都是 PT9H。存着不会重复
-- 提醒（normalizeAlarms 按语义去重），但网页表单会把第二条当成「另外寄存了 1 条」
-- 显示给用户看，凭空多出一条他没设过的提醒。这里按改写后的 trigger 原文去重，
-- 保留最靠前的那条。不是对象、或者没有 trigger 键的元素给一个各不相同的 key，
-- 不会被这一步吃掉。
WITH scope AS MATERIALIZED (
  SELECT ev.id, ev.extra -> 'alarms' AS alarms
    FROM events ev
   WHERE ev.all_day
     AND ev.deleted_at IS NULL
     AND jsonb_typeof(ev.extra) = 'object'
     AND jsonb_typeof(ev.extra -> 'alarms') = 'array'
     AND (ev.raw_ics IS NULL OR strpos(ev.raw_ics, 'BEGIN:VEVENT') = 0)
     AND (ev.rrule IS NOT NULL OR ev.starts_at > now())
),
mapping (old_trigger, new_trigger) AS (
  VALUES ('-PT0M', 'PT9H'),
         ('-PT5M', 'PT9H'),
         ('-PT15M', 'PT9H'),
         ('-PT30M', 'PT9H'),
         ('-PT1H', 'PT9H'),
         ('-PT2H', 'PT9H'),
         ('-P1D', '-PT15H'),
         ('-P1W', '-P6DT15H')
),
expanded AS (
  SELECT s.id,
         el.ord,
         CASE WHEN m.new_trigger IS NULL THEN el.elem
              ELSE jsonb_set(el.elem, '{trigger}', to_jsonb(m.new_trigger)) END AS elem,
         CASE WHEN m.new_trigger IS NOT NULL THEN m.new_trigger
              WHEN jsonb_typeof(el.elem) = 'object' AND el.elem ->> 'trigger' IS NOT NULL
                THEN btrim(el.elem ->> 'trigger')
              ELSE '#ord:' || el.ord::text END AS dedupe_key,
         (m.new_trigger IS NOT NULL) AS rewritten
    FROM scope s
    CROSS JOIN LATERAL jsonb_array_elements(s.alarms) WITH ORDINALITY AS el (elem, ord)
    LEFT JOIN mapping m
      ON jsonb_typeof(el.elem) = 'object'
     AND btrim(coalesce(el.elem ->> 'trigger', '')) = m.old_trigger
),
kept AS (
  SELECT DISTINCT ON (id, dedupe_key) id, ord, elem
    FROM expanded
   ORDER BY id, dedupe_key, ord
),
rebuilt AS (
  SELECT k.id, jsonb_agg(k.elem ORDER BY k.ord) AS alarms
    FROM kept k
   WHERE EXISTS (SELECT 1 FROM expanded e WHERE e.id = k.id AND e.rewritten)
   GROUP BY k.id
)
UPDATE events e
   SET extra = jsonb_set(e.extra, '{alarms}', r.alarms)
  FROM rebuilt r
 WHERE e.id = r.id;
