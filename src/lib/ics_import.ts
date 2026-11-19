import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { parseEvents, type IcalEvent } from "./ical.js";
import { safeFetch, SsrfBlockedError } from "./ssrf_guard.js";
import { canonicalTimeZone } from "./zoned_time.js";
import { expansionTimeZone, rawIcsStartIsUtc } from "./event_zone.js";
import { remapSeriesForZoneChange } from "./exdate_remap.js";
import { env } from "../env.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap on remote ICS responses

export type ImportResult = {
  inserted: number;
  updated: number;
  skipped: number;
  total: number;
};

export async function importIcsText(
  calendarId: string,
  text: string,
  opts: { sourceTag?: string | null } = {},
): Promise<ImportResult> {
  const parsed = parseEvents(text);
  return upsertEvents(calendarId, parsed, opts.sourceTag ?? null);
}

export async function fetchIcsUrl(url: string): Promise<string> {
  // Some providers use webcal://; rewrite to https.
  let normalized = url.trim();
  if (normalized.toLowerCase().startsWith("webcal://")) {
    normalized = "https://" + normalized.slice(9);
  }
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error("URL 必须以 http(s):// 开头（webcal:// 会自动改写为 https://）");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let body: string;
  try {
    // SSRF guard: this URL is fully user-controlled (ICS subscription).
    // safeFetch validates protocol, rejects embedded credentials, blocks
    // private/loopback/link-local/reserved IP targets, and re-validates
    // every redirect hop. Operators can opt into internal targets via
    // ICS_ALLOW_PRIVATE_NETWORK.
    const resp = await safeFetch(normalized, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "ByWave-Calendar/1.0 (ICS importer)" },
      allowPrivate: env.ICS_ALLOW_PRIVATE_NETWORK,
    });
    if (!resp.ok) {
      await resp.body?.cancel();
      throw new Error(`远程返回 HTTP ${resp.status}`);
    }
    const buf = await readLimitedIcsBody(resp);
    body = buf.toString("utf8");
  } catch (err) {
    // Surface the SSRF rejection as a clean, user-readable message rather
    // than leaking it as an opaque fetch failure.
    if (err instanceof SsrfBlockedError) throw new Error(err.message);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!body.toUpperCase().includes("BEGIN:VCALENDAR")) {
    throw new Error("返回内容不是 iCalendar 格式（缺少 BEGIN:VCALENDAR）");
  }
  return body;
}

/** Enforce the limit while reading, before an oversized response fills memory. */
export async function readLimitedIcsBody(resp: Response): Promise<Buffer> {
  const tooLarge = () => new Error(`文件过大（>${MAX_BYTES / 1024 / 1024} MB）`);
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await resp.body?.cancel();
    throw tooLarge();
  }
  if (!resp.body) return Buffer.alloc(0);
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

/**
 * 算出这次导入要写进 events.extra 的值：**在现有 extra 上浅合并**，不是整块替换。
 *
 * 原来这里是 `const extra = {}; if (sourceTag) extra.source = sourceTag;`，insert 和
 * onConflictDoUpdate 都写这一块。于是订阅每刷新一次（默认 5 分钟一轮），用户给这个
 * 事件设的提醒、分类、参与者、时区就被整块抹成 `{source}` —— 没有任何报错，
 * 用户只会发现「提醒时不时就自己没了」。
 *
 * alarms 的口径和 CalDAV PUT 故意不同：
 *   - 上游带了 VALARM → 以上游为准。订阅进来的日程本来就带提醒（球赛开赛前 1 小时、
 *     课表提前 15 分钟），不落等于把上游信息丢了，用户还得自己在每个事件上重设一遍。
 *   - 上游没带 VALARM → **保留库里已有的**，不清空。订阅刷新是我们单方面去拉的，
 *     上游从没看过用户在我们这儿加的提醒，它「没有 VALARM」只说明这个源不发提醒
 *     （节假日、球赛表大多如此），不构成「删掉提醒」的意思表示。
 *     CalDAV PUT 那边能当成删除，是因为客户端刚完整读过这份资源又完整写了回来。
 */
export function mergeImportExtra(
  existingExtra: unknown,
  sourceTag: string | null,
  alarms: IcalEvent["alarms"],
  timezone: string | null = null,
): Record<string, unknown> | null {
  const base = existingExtra && typeof existingExtra === "object" && !Array.isArray(existingExtra)
    ? { ...(existingExtra as Record<string, unknown>) }
    : {};
  if (sourceTag) base.source = sourceTag;
  if (Array.isArray(alarms) && alarms.length) base.alarms = alarms;
  if (timezone) base.timezone = timezone;
  return Object.keys(base).length ? base : null;
}

/**
 * 导入 / 订阅进来的定时重复事件要记下按哪个时区展开（event_zone.ts 第 3 条）。
 * 不记的话会退到日历的时区 —— 每个账号的默认日历都是 Asia/Shanghai，欧美来的订阅源里
 * 「每周一」晚上的课会按上海时间算、错一天。
 *   · 源文件 DTSTART 带 TZID、规范得成 IANA 名（PRC、US/Eastern 这类别名也算）：用规范后的名字。
 *   · 写成 UTC（…Z）、浮动时间、TZID 不认识：UTC。这三种 parseICalDateValue 都是按 UTC
 *     读进来的，按 UTC 展开才和读进来的那个时刻是一回事（也就是 1.7.4 之前的展开方式）。
 *     「+08:00」这种 Intl 认、但不算时区名的写法例外：时刻是按 +8 读的，按 UTC 排的话
 *     晚上 8 点前后的会错一天。这种源极少见，先记 UTC。
 * 不重复的、全天的不记：单个时刻写成 UTC 是精确的，不需要。
 */
export function importTimeZone(ev: Pick<IcalEvent, "allDay" | "rrule" | "timezone">): string | null {
  if (ev.allDay || !ev.rrule) return null;
  return canonicalTimeZone(ev.timezone) ?? "UTC";
}

/**
 * 键排序后再 stringify，只用来判「这次刷新有没有真的变」。
 *
 * 不能直接比 JSON 文本：Postgres 的 jsonb 会按「键长度 → 字节序」重排键，读回来的
 * `{"action":…,"trigger":…,"description":…}` 和我们刚拼出来的
 * `{"trigger":…,"action":…,"description":…}` 内容一模一样、文本不同。
 * 直接比就等于每 5 分钟判定一次「变了」、白写一次 updatedAt，而 CalDAV 的 etag 就是
 * etagOf(updatedAt) —— etag 一直在动，Apple 日历带 If-Match 的 PUT 就会 412，
 * 用户看到的是「无法更新日历」。
 */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}

async function calendarTimezoneOf(calendarId: string): Promise<string | null> {
  const [cal] = await db.select({ timezone: schema.calendars.timezone })
    .from(schema.calendars).where(eq(schema.calendars.id, calendarId)).limit(1);
  return cal?.timezone ?? null;
}

type EventRow = typeof schema.events.$inferSelect;

/** 预查现有行时每条 IN 查询带多少个 uid。 */
const PREFETCH_UID_CHUNK = 500;
/** 落库时每条多行 upsert 带多少行（每行约 12 个参数，离 PG 的参数上限还很远）。 */
const UPSERT_ROW_CHUNK = 200;

/**
 * 一次导入里某个 uid 最终要落库的样子。同一文件里同 uid 出现多次时按顺序合并：
 * 最后一个版本的内容字段胜出；exdates 只有被时区重映射改过才动，没改的那一版
 * 不许把先前那一版的重映射冲掉（和逐条写时「没重映射就不碰 exdates 列」一致）。
 */
type PendingWrite = {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  rrule: string | null;
  extra: Record<string, unknown> | null;
  remappedExdates: string[] | undefined;
};

/**
 * 一次导入的「判定结果」：哪些新增、哪些更新、哪些跳过、要写哪些行。
 * 真实导入（upsertEvents）和导入预览（previewIcsText）共用这一份判定 ——
 * 预览说新增 X、导入就必须是新增 X，两边各写一套迟早对不上。
 * 这里只读库（预查现有行、日历时区），一个字都不写。
 */
type ImportPlan = {
  inserted: number;
  updated: number;
  /** 重复跳过：内容和库里一模一样 + 已软删不复活。真实导入里算 skipped。 */
  duplicates: number;
  /** 无效：解析出来了但缺 uid / 标题。真实导入里算 skipped。 */
  invalid: number;
  invalidReasons: string[];
  pending: PendingWrite[];
};

async function planImport(
  calendarId: string,
  parsed: IcalEvent[],
  sourceTag: string | null,
): Promise<ImportPlan> {
  let inserted = 0;
  let updated = 0;
  let duplicates = 0;
  let invalid = 0;
  const invalidReasons: string[] = [];
  let calendarTimezone: string | null | undefined;

  // ---- 第一步：按原顺序把 uid 定下来（短 uid 合成规则和以前一字不差） ----
  //
  // Stable synthetic uid for suspiciously-short source uids.
  //
  // BUG (fixed here): this used to be `${ev.uid}-${newEventUid()}` — a
  // RANDOM suffix minted fresh on every call. That broke idempotency:
  // the (calendarId, uid) conflict target never matched on re-import, so
  // every manual re-import AND every 5-minute subscription refresh
  // INSERTED a brand-new row → the "one event became several copies"
  // duplication. Derive the suffix DETERMINISTICALLY from the event's
  // identity instead, so the same source event maps to the same row
  // across imports, while two genuinely-distinct events that happen to
  // share a short source uid still resolve to different uids.
  const items: { ev: IcalEvent; uid: string }[] = [];
  for (const ev of parsed) {
    if (!ev.uid || !ev.summary) {
      invalid++;
      if (invalidReasons.length < 5) invalidReasons.push("有一条事件缺少 UID 或标题");
      continue;
    }
    const uid = ev.uid.length >= 8
      ? ev.uid
      : `${ev.uid}-${createHash("sha1")
          .update(`${ev.uid}|${ev.summary}|${ev.startsAt.toISOString()}|${ev.endsAt.toISOString()}`)
          .digest("hex")
          .slice(0, 12)}`;
    items.push({ ev, uid });
  }

  // ---- 第二步：现有行按 uid 一次预查（分块 IN），不再逐条 SELECT ----
  //
  // 为什么要先查：为了 SKIP 无变化的写。每次刷新都重写 updatedAt —— 哪怕内容
  // 没变 —— 会让 CalDAV 的 etag（etag = etagOf(updatedAt)）一直动。Apple 日历
  // 缓存 etag，etag 老在动，它的 If-Match PUT 就 412 → 用户看到「无法更新
  // 日历 / The calendar could not be updated」。只有用户可见字段真的变了才写。
  const byUid = new Map<string, EventRow>();
  const distinctUids = [...new Set(items.map((i) => i.uid))];
  for (let i = 0; i < distinctUids.length; i += PREFETCH_UID_CHUNK) {
    const chunk = distinctUids.slice(i, i + PREFETCH_UID_CHUNK);
    const rows = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.calendarId, calendarId), inArray(schema.events.uid, chunk)));
    for (const r of rows) byUid.set(r.uid, r);
  }

  // ---- 第三步：按原顺序逐条判定（纯内存），要写的先攒着 ----
  //
  // 判定规则和逐条版完全一致，差别只在「现有行」来自预查的 Map。每判定出一笔
  // 写，就立刻把 Map 里那行换成写完之后的样子 —— 这样同一文件里同 uid 第二次
  // 出现时，比较对象和逐条版从库里现查到的一样，后者覆盖前者的语义不变。
  const pending = new Map<string, PendingWrite>();

  for (const { ev, uid } of items) {
    const desc = ev.description ?? null;
    const loc = ev.location ?? null;
    const rrule = ev.rrule ?? null;
    const existing = byUid.get(uid);

    const extraVal = mergeImportExtra(existing?.extra ?? null, sourceTag, ev.alarms ?? null, importTimeZone(ev));
    // 这次刷新 / 重新导入把展开时区换了（升级后第一次刷新补上源时区就是这样）：用户在我们这边
    // 「删掉这一次」记下的那几次要跟着对过去，不然删过的又冒出来。规则是上游给的，UNTIL 不替它挪。
    let remappedExdates: string[] | undefined;
    if (existing && !existing.allDay && !ev.allDay && rrule && Array.isArray(existing.exdates) && existing.exdates.length) {
      calendarTimezone ??= await calendarTimezoneOf(calendarId);
      const fromZone = expansionTimeZone({
        allDay: false, extra: existing.extra, calendarTimezone, rawStartIsUtc: rawIcsStartIsUtc(existing.rawIcs),
      });
      const toZone = expansionTimeZone({ allDay: false, extra: extraVal, calendarTimezone });
      remappedExdates = remapSeriesForZoneChange({
        startsAt: ev.startsAt, rrule, allDay: false, exdates: existing.exdates, fromZone, toZone,
      }).exdates;
    }

    if (existing) {
      // Leave soft-deleted rows alone: don't resurrect something the user
      // (or the dedupe script) removed, and don't churn its updatedAt.
      if (existing.deletedAt != null) { duplicates++; continue; }
      const unchanged =
        existing.summary === ev.summary &&
        (existing.description ?? null) === desc &&
        (existing.location ?? null) === loc &&
        existing.startsAt.getTime() === ev.startsAt.getTime() &&
        existing.endsAt.getTime() === ev.endsAt.getTime() &&
        existing.allDay === ev.allDay &&
        (existing.rrule ?? null) === rrule &&
        // 提醒也要算进「有没有变」。不算的话上游把提醒从「提前 1 小时」改成「提前 1 天」
        // 而别的字段没动，这里会判定 unchanged 直接 skip，新提醒永远落不了库 ——
        // extraVal 已经算好了，只是没人写进去，症状是「上游改了但我们这边没反应」。
        stableJson(extraVal) === stableJson(existing.extra ?? null) &&
        !remappedExdates;
      if (unchanged) { duplicates++; continue; }
      updated++;
    } else {
      inserted++;
    }

    const prev = pending.get(uid);
    const write: PendingWrite = {
      uid,
      summary: ev.summary,
      description: desc,
      location: loc,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      allDay: ev.allDay,
      rrule,
      extra: extraVal,
      remappedExdates: remappedExdates ?? prev?.remappedExdates,
    };
    pending.set(uid, write);

    // 把 Map 里那行换成写完之后的样子（见第三步开头的说明）。新行里导入不碰的
    // 字段（rawIcs 等）按落库后的实际值给：插入时它们就是默认值 null。
    byUid.set(uid, {
      id: existing?.id ?? "",
      calendarId,
      uid,
      summary: write.summary,
      description: write.description,
      location: write.location,
      startsAt: write.startsAt,
      endsAt: write.endsAt,
      allDay: write.allDay,
      rrule: write.rrule,
      exdates: write.remappedExdates ?? existing?.exdates ?? null,
      extra: write.extra,
      rawIcs: existing?.rawIcs ?? null,
      deletedAt: null,
      createdAt: existing?.createdAt ?? write.startsAt,
      updatedAt: existing?.updatedAt ?? write.startsAt,
    });
  }

  return {
    inserted,
    updated,
    duplicates,
    invalid,
    invalidReasons,
    pending: [...pending.values()],
  };
}

async function upsertEvents(
  calendarId: string,
  parsed: IcalEvent[],
  sourceTag: string | null,
): Promise<ImportResult> {
  const plan = await planImport(calendarId, parsed, sourceTag);

  // ---- 落库：攒下的写分块，一块一条多行 upsert、一个事务 ----
  //
  // 分两组是因为 SET 子句一条语句里只能有一套：改过 exdates 的行要连 exdates
  // 一起写；没改过的行 SET 里不带 exdates —— 和逐条版一样不碰那一列（预查之后
  // 用户刚删掉的某一次出现，不会被导入拿旧快照盖回去）。
  const plainWrites = plan.pending.filter((w) => !w.remappedExdates);
  const exdateWrites = plan.pending.filter((w) => w.remappedExdates);
  await flushUpsertChunk(calendarId, plainWrites, false);
  await flushUpsertChunk(calendarId, exdateWrites, true);

  return {
    inserted: plan.inserted,
    updated: plan.updated,
    skipped: plan.duplicates + plan.invalid,
    total: parsed.length,
  };
}

// ---------- 导入预览（只判定，不落库） ----------

export type ImportPreview = {
  /** 文件里的 VEVENT 块总数（含解析不出来的那些）。 */
  total: number;
  /** 预计新增。 */
  inserted: number;
  /** 预计更新（库里已有、内容变了的）。 */
  updated: number;
  /** 重复跳过：内容和库里一模一样 + 已删掉不复活的。 */
  duplicates: number;
  /** 无效：解析不出来 + 缺 uid/标题。 */
  invalid: number;
  /** 无效原因摘要，最多 5 条。 */
  invalidReasons: string[];
};

/**
 * 数一遍文本里的 VEVENT 块、并给解析不出来的块找原因（缺哪几个必填字段）。
 * parseEvent 丢弃一个块只有两种情况：块本身不完整（没有 END:VEVENT）、
 * 或者缺 UID / SUMMARY / DTSTART / DTEND 之一（见 ical.ts）。这里按同一套
 * 展开规则走一遍块，只用来给用户解释，不参与导入判定（判定在 planImport）。
 */
function droppedBlockReasons(text: string): { blocks: number; reasons: string[] } {
  const unfolded = text.replace(/\r?\n[\t ]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const reasons: string[] = [];
  let blocks = 0;
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] ?? "").toUpperCase() === "BEGIN:VEVENT") {
      blocks++;
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? "").toUpperCase() !== "END:VEVENT") j++;
      if (j >= lines.length) {
        if (reasons.length < 5) reasons.push(`第 ${blocks} 条事件不完整（缺少 END:VEVENT）`);
        break;
      }
      const present = new Set<string>();
      for (let k = i + 1; k < j; k++) {
        const m = /^([A-Za-z0-9-]+)[;:]/u.exec(lines[k] ?? "");
        if (m) present.add(m[1]!.toUpperCase());
      }
      const missing = ["UID", "SUMMARY", "DTSTART", "DTEND"].filter((p) => !present.has(p));
      if (missing.length && reasons.length < 5) {
        reasons.push(`第 ${blocks} 条事件缺少 ${missing.join("、")}`);
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return { blocks, reasons };
}

/**
 * 预览一次导入：解析 + 判定，**不落库、不留任何临时数据**。
 * 判定走 planImport，和真实导入同一份代码、同一个 sourceTag 口径 ——
 * 调用方必须传和随后真实导入一样的 sourceTag（它参与 extra 合并、
 * 影响「内容有没有变」的判定），否则预览和导入会对不上。
 */
export async function previewIcsText(
  calendarId: string,
  text: string,
  opts: { sourceTag?: string | null } = {},
): Promise<ImportPreview> {
  const parsed = parseEvents(text);
  const plan = await planImport(calendarId, parsed, opts.sourceTag ?? null);
  const { blocks, reasons } = droppedBlockReasons(text);
  const unparsed = Math.max(0, blocks - parsed.length);
  return {
    total: parsed.length + unparsed,
    inserted: plan.inserted,
    updated: plan.updated,
    duplicates: plan.duplicates,
    invalid: plan.invalid + unparsed,
    invalidReasons: [...reasons, ...plan.invalidReasons].slice(0, 5),
  };
}

async function flushUpsertChunk(
  calendarId: string,
  writes: PendingWrite[],
  withExdates: boolean,
): Promise<void> {
  for (let i = 0; i < writes.length; i += UPSERT_ROW_CHUNK) {
    const chunk = writes.slice(i, i + UPSERT_ROW_CHUNK);
    const now = new Date();
    const values = chunk.map((w) => ({
      calendarId,
      uid: w.uid,
      summary: w.summary,
      description: w.description,
      location: w.location,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      allDay: w.allDay,
      rrule: w.rrule,
      extra: w.extra,
      ...(withExdates ? { exdates: w.remappedExdates ?? null } : {}),
      updatedAt: now,
    }));
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.events)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.events.calendarId, schema.events.uid],
          set: {
            summary: sql`excluded.summary`,
            description: sql`excluded.description`,
            location: sql`excluded.location`,
            startsAt: sql`excluded.starts_at`,
            endsAt: sql`excluded.ends_at`,
            allDay: sql`excluded.all_day`,
            rrule: sql`excluded.rrule`,
            extra: sql`excluded.extra`,
            ...(withExdates ? { exdates: sql`excluded.exdates` } : {}),
            updatedAt: sql`excluded.updated_at`,
          },
        });
    });
  }
}

// ---------- Subscription refresh ----------

export async function refreshSubscription(subId: string): Promise<{ ok: true; result: ImportResult } | { ok: false; error: string }> {
  const [sub] = await db
    .select()
    .from(schema.calendarSubscriptions)
    .where(eq(schema.calendarSubscriptions.id, subId))
    .limit(1);
  if (!sub) return { ok: false, error: "subscription_not_found" };
  try {
    const text = await fetchIcsUrl(sub.url);
    // Surface a clear error when the upstream returned HTML / login page
    // instead of an actual ICS feed. Without this check refreshSubscription
    // happily "succeeds" with 0 events, hiding the real issue from the user.
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("BEGIN:VCALENDAR")) {
      const preview = trimmed.slice(0, 80).replace(/\s+/g, " ");
      throw new Error(`URL didn't return an ICS feed (got: "${preview}…"). Check the link — needs to be a webcal:// or .ics URL, not an HTML page.`);
    }
    const result = await importIcsText(sub.calendarId, text, { sourceTag: `sub:${sub.id}` });
    await db
      .update(schema.calendarSubscriptions)
      .set({
        lastFetchedAt: new Date(),
        lastStatus: "ok",
        lastError: null,
        lastEventCount: result.total,
      })
      .where(eq(schema.calendarSubscriptions.id, sub.id));
    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.calendarSubscriptions)
      .set({
        lastFetchedAt: new Date(),
        lastStatus: "error",
        lastError: msg.slice(0, 500),
      })
      .where(eq(schema.calendarSubscriptions.id, sub.id));
    return { ok: false, error: msg };
  }
}

// Background scheduler: every 5 minutes, refresh any subscription whose
// (last_fetched_at + refresh_minutes) is in the past, or which has never run.
let schedulerStarted = false;
const FIVE_MIN = 5 * 60 * 1000;

export function startSubscriptionScheduler(logger: { info: (m: string) => void; warn: (m: unknown) => void }): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const tick = makeSubscriptionTick(logger, async () => {
    try {
      const rows = await db
        .select({ id: schema.calendarSubscriptions.id })
        .from(schema.calendarSubscriptions)
        .where(sql`(${schema.calendarSubscriptions.lastFetchedAt} IS NULL
          OR ${schema.calendarSubscriptions.lastFetchedAt} + (${schema.calendarSubscriptions.refreshMinutes} * interval '1 minute') < now())`);
      for (const r of rows) {
        const res = await refreshSubscription(r.id);
        if (!res.ok) logger.warn({ subId: r.id, error: res.error });
      }
    } catch (err) {
      logger.warn({ err });
    }
  });
  setTimeout(() => { void tick(); }, 30_000);
  setInterval(() => { void tick(); }, FIVE_MIN);
  logger.info("subscription scheduler started (5-min tick)");
}

/** A slow refresh must finish before the next interval starts another batch. */
export function makeSubscriptionTick(
  logger: { warn: (m: unknown) => void },
  refresh: () => Promise<void>,
): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) {
      logger.warn({ msg: "subscription refresh still running; skipping this tick" });
      return;
    }
    inFlight = true;
    try { await refresh(); }
    catch (err) { logger.warn({ err }); }
    finally { inFlight = false; }
  };
}
