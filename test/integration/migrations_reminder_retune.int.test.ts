// 0049 / 0050 两条数据迁移，在真 Postgres（PGlite）上跑，断言「只有该改的被改了」。
//
// 为什么非得这么测：这两条迁移是**纯 SQL**，没有任何一行 TypeScript 参与。
// 直调某个函数的测试在这里连被测对象都找不到 —— 唯一能被测的东西就是
// 「把 .sql 文件喂给数据库之后，哪些行变了、哪些行没变」。
//
// 每条断言都要能红：改宽 0049 的 WHERE（比如去掉 starts_at > now()），
// 「已经过去的那行没动」当场红；改宽 0050 的范围，「raw_ics 回放的事件没被 bump」当场红。
import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { pg, db, schema, ensureSchema, resetDb, makeUser, makeCalendar } from "./harness.js";

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => { await resetDb(); });

const RETUNE = "drizzle/migrations/0049_allday_reminder_retune.sql";
const RESYNC = "drizzle/migrations/0050_caldav_alarm_resync.sql";

/** 0050 里写死的那个常量。测试和迁移文件对不上就该红 —— 见「常量没跑偏」那条。 */
const RESYNC_STAMP = "2026-09-21T02:00:00.000Z";

/** 按仓库迁移器的方式跑一个迁移文件：按 statement-breakpoint 拆开逐条执行。 */
async function runMigration(file: string): Promise<void> {
  const sql = readFileSync(file, "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const t = stmt.trim();
    if (t) await pg.exec(t);
  }
}

type Alarm = { trigger?: unknown; action?: unknown; description?: unknown };

const FUTURE = new Date("2099-06-15T00:00:00Z");   // 全天事件的 starts_at 是当天 UTC 午夜
const PAST = new Date("2020-06-15T00:00:00Z");

let calendarId = "";

async function seedCalendar(): Promise<string> {
  const u = await makeUser(`m${Date.now()}${Math.random()}@example.com`);
  const c = await makeCalendar(u.id, "Cal");
  return c.id;
}

type SeedOpts = {
  uid: string;
  alarms: unknown[];
  allDay?: boolean;
  startsAt?: Date;
  rrule?: string | null;
  rawIcs?: string | null;
  deletedAt?: Date | null;
  extra?: Record<string, unknown>;
  updatedAt?: Date;
};

async function seedEvent(o: SeedOpts): Promise<string> {
  const starts = o.startsAt ?? FUTURE;
  const [row] = await db.insert(schema.events).values({
    calendarId,
    uid: o.uid,
    summary: o.uid,
    startsAt: starts,
    endsAt: new Date(starts.getTime() + 24 * 3600_000),
    allDay: o.allDay ?? true,
    rrule: o.rrule ?? null,
    rawIcs: o.rawIcs ?? null,
    deletedAt: o.deletedAt ?? null,
    extra: { timezone: "Asia/Shanghai", alarms: o.alarms, ...(o.extra ?? {}) },
    updatedAt: o.updatedAt ?? new Date("2026-01-02T03:04:05.000Z"),
  }).returning();
  return row!.id;
}

async function alarmsOf(id: string): Promise<Alarm[]> {
  const [row] = await db.select().from(schema.events).where(eq(schema.events.id, id)).limit(1);
  const extra = (row!.extra ?? {}) as { alarms?: unknown };
  return (Array.isArray(extra.alarms) ? extra.alarms : []) as Alarm[];
}

async function triggersOf(id: string): Promise<unknown[]> {
  return (await alarmsOf(id)).map((a) => a.trigger);
}

async function updatedAtOf(id: string): Promise<string> {
  const [row] = await db.select().from(schema.events).where(eq(schema.events.id, id)).limit(1);
  return row!.updatedAt.toISOString();
}

// ---------------------------------------------------------------------------

describe("0049 全天提醒档位改写", () => {
  beforeEach(async () => { calendarId = await seedCalendar(); });

  it("八个老档位分别翻译成对应的新档位", async () => {
    const ids: Record<string, string> = {};
    const table: Array<[string, string]> = [
      ["-PT0M", "PT9H"],
      ["-PT5M", "PT9H"],
      ["-PT15M", "PT9H"],
      ["-PT30M", "PT9H"],
      ["-PT1H", "PT9H"],
      ["-PT2H", "PT9H"],
      ["-P1D", "-PT15H"],
      ["-P1W", "-P6DT15H"],
    ];
    for (const [oldT] of table) {
      ids[oldT] = await seedEvent({ uid: `t${oldT}`, alarms: [{ trigger: oldT, action: "DISPLAY" }] });
    }
    await runMigration(RETUNE);
    for (const [oldT, newT] of table) {
      expect(await triggersOf(ids[oldT]!), `${oldT} 应该翻译成 ${newT}`).toEqual([newT]);
    }
  });

  it("已经过去的非重复事件一个字都不动", async () => {
    const id = await seedEvent({ uid: "past", startsAt: PAST, alarms: [{ trigger: "-PT15M" }] });
    await runMigration(RETUNE);
    expect(await triggersOf(id)).toEqual(["-PT15M"]);
  });

  it("重复事件即使 starts_at 在过去也要改 —— 未来的实例还在", async () => {
    const id = await seedEvent({
      uid: "rec", startsAt: PAST, rrule: "FREQ=WEEKLY", alarms: [{ trigger: "-P1D" }],
    });
    await runMigration(RETUNE);
    expect(await triggersOf(id)).toEqual(["-PT15H"]);
  });

  it("非全天事件不动 —— 那边 -PT15M 的意思本来就是对的", async () => {
    const id = await seedEvent({ uid: "timed", allDay: false, alarms: [{ trigger: "-PT15M" }] });
    await runMigration(RETUNE);
    expect(await triggersOf(id)).toEqual(["-PT15M"]);
  });

  it("raw_ics 里有 VEVENT 的事件不动 —— 那条 VALARM 归客户端管", async () => {
    const id = await seedEvent({
      uid: "raw", rawIcs: "BEGIN:VEVENT\r\nUID:raw\r\nEND:VEVENT", alarms: [{ trigger: "-PT15M" }],
    });
    await runMigration(RETUNE);
    expect(await triggersOf(id)).toEqual(["-PT15M"]);
  });

  it("raw_ics 有内容但不含 VEVENT 的照改 —— 回放路径看的就是这个判据", async () => {
    const id = await seedEvent({ uid: "rawjunk", rawIcs: "X-JUNK:1", alarms: [{ trigger: "-PT15M" }] });
    await runMigration(RETUNE);
    expect(await triggersOf(id)).toEqual(["PT9H"]);
  });

  it("软删掉的事件不动", async () => {
    const id = await seedEvent({
      uid: "del", deletedAt: new Date("2026-02-01T00:00:00Z"), alarms: [{ trigger: "-PT15M" }],
    });
    await runMigration(RETUNE);
    expect(await triggersOf(id)).toEqual(["-PT15M"]);
  });

  it("已经是新档位的、以及认不出的 trigger，原样留着", async () => {
    const id = await seedEvent({
      uid: "mixed",
      alarms: [{ trigger: "PT9H" }, { trigger: "-PT15H" }, { trigger: "banana" }, { trigger: "-PT45M" }],
    });
    await runMigration(RETUNE);
    expect(await triggersOf(id)).toEqual(["PT9H", "-PT15H", "banana", "-PT45M"]);
  });

  it("action / description / extra 里其他的键一个都不丢", async () => {
    const id = await seedEvent({
      uid: "keep",
      alarms: [{ trigger: "-PT15M", action: "AUDIO", description: "站会" }],
      extra: { attendees: ["a@example.com"], url: "https://example.com" },
    });
    await runMigration(RETUNE);
    expect(await alarmsOf(id)).toEqual([{ trigger: "PT9H", action: "AUDIO", description: "站会" }]);
    const [row] = await db.select().from(schema.events).where(eq(schema.events.id, id)).limit(1);
    const extra = row!.extra as Record<string, unknown>;
    expect(extra.timezone).toBe("Asia/Shanghai");
    expect(extra.attendees).toEqual(["a@example.com"]);
    expect(extra.url).toBe("https://example.com");
  });

  it("两个老档位映射到同一个新档位时只留一条，不凭空多出一条用户没设过的提醒", async () => {
    const id = await seedEvent({
      uid: "dup", alarms: [{ trigger: "-PT5M" }, { trigger: "-PT15M" }, { trigger: "-P1D" }],
    });
    await runMigration(RETUNE);
    expect(await triggersOf(id)).toEqual(["PT9H", "-PT15H"]);
  });

  it("alarms 里混进来的非对象元素不会被去重那一步吃掉", async () => {
    const id = await seedEvent({ uid: "junk", alarms: ["x", "y", { trigger: "-PT15M" }] });
    await runMigration(RETUNE);
    expect(await alarmsOf(id)).toEqual(["x", "y", { trigger: "PT9H" }] as unknown as Alarm[]);
  });

  it("extra 不是对象、或者 alarms 不是数组时不报错也不动", async () => {
    const a = await seedEvent({ uid: "noalarms", alarms: [] });
    await pg.exec(`UPDATE events SET extra = '"hello"'::jsonb WHERE uid = 'noalarms'`);
    const b = await seedEvent({ uid: "nullextra", alarms: [] });
    await pg.exec(`UPDATE events SET extra = NULL WHERE uid = 'nullextra'`);
    const c = await seedEvent({ uid: "strAlarms", alarms: [] });
    await pg.exec(`UPDATE events SET extra = '{"alarms":"-PT15M"}'::jsonb WHERE uid = 'strAlarms'`);
    await runMigration(RETUNE);
    const rows = await db.select().from(schema.events);
    const byId = new Map(rows.map((r) => [r.id, r.extra]));
    expect(byId.get(a)).toBe("hello");
    expect(byId.get(b)).toBeNull();
    expect(byId.get(c)).toEqual({ alarms: "-PT15M" });
  });

  it("在范围内、但没有一条 trigger 需要翻译的事件，一个字都不碰", async () => {
    // 这条盯的是「这次真改了点什么」那道门。没有它，迁移会把范围内所有事件的
    // alarms 都重写一遍 —— 内容看着一样，但顺手把人家自己带的重复项也去掉了。
    // 迁移只负责翻译档位，不负责替用户清理他自己设的东西。
    const id = await seedEvent({
      uid: "notouch", alarms: [{ trigger: "-PT45M" }, { trigger: "-PT45M" }, { trigger: "PT9H" }],
    });
    await runMigration(RETUNE);
    expect(await triggersOf(id)).toEqual(["-PT45M", "-PT45M", "PT9H"]);
  });

  it("跑两遍结果完全一致，不报错", async () => {
    const ids = [
      await seedEvent({ uid: "a", alarms: [{ trigger: "-PT15M" }, { trigger: "-P1W" }] }),
      await seedEvent({ uid: "b", startsAt: PAST, alarms: [{ trigger: "-PT15M" }] }),
      await seedEvent({ uid: "c", allDay: false, alarms: [{ trigger: "-PT1H" }] }),
      await seedEvent({ uid: "d", rrule: "FREQ=DAILY", startsAt: PAST, alarms: [{ trigger: "-P1D" }] }),
    ];
    await runMigration(RETUNE);
    const first = await Promise.all(ids.map((id) => alarmsOf(id)));
    await runMigration(RETUNE);
    const second = await Promise.all(ids.map((id) => alarmsOf(id)));
    expect(second).toEqual(first);
  });
});

describe("0049 换档当天的重复提醒压制", () => {
  beforeEach(async () => { calendarId = await seedCalendar(); });

  const INSTANCE = new Date("2099-06-15T00:00:00Z");
  const SENT = new Date("2026-03-01T08:00:00.000Z");

  async function sentRows(eventId: string) {
    return db.select().from(schema.remindersSent).where(eq(schema.remindersSent.eventId, eventId));
  }

  it("旧 trigger 已经发过的那个实例，新 trigger 名下补一行「已发」，sent_at 沿用旧行", async () => {
    const id = await seedEvent({ uid: "s1", alarms: [{ trigger: "-P1D" }] });
    await db.insert(schema.remindersSent).values({
      eventId: id, trigger: "-P1D", instanceStart: INSTANCE, sentAt: SENT,
    });
    await runMigration(RETUNE);
    const rows = await sentRows(id);
    const mapped = rows.find((r) => r.trigger === "-PT15H");
    expect(mapped, "没有补出新 trigger 的已发行 = 换档当天会重复提醒一次").toBeTruthy();
    expect(mapped!.instanceStart.toISOString()).toBe(INSTANCE.toISOString());
    expect(mapped!.sentAt.toISOString()).toBe(SENT.toISOString());
  });

  it("只压已经发生过的那个实例，别的实例一条都不碰", async () => {
    const id = await seedEvent({ uid: "s2", rrule: "FREQ=WEEKLY", startsAt: PAST, alarms: [{ trigger: "-P1D" }] });
    await db.insert(schema.remindersSent).values({
      eventId: id, trigger: "-P1D", instanceStart: new Date("2026-03-02T00:00:00Z"), sentAt: SENT,
    });
    await runMigration(RETUNE);
    const rows = await sentRows(id);
    expect(rows.filter((r) => r.trigger === "-PT15H").map((r) => r.instanceStart.toISOString()))
      .toEqual(["2026-03-02T00:00:00.000Z"]);
  });

  it("不在改写范围里的事件不补 —— 补了就是把一条真该响的提醒压掉", async () => {
    const id = await seedEvent({ uid: "s3", startsAt: PAST, alarms: [{ trigger: "-P1D" }] });
    await db.insert(schema.remindersSent).values({
      eventId: id, trigger: "-P1D", instanceStart: PAST, sentAt: SENT,
    });
    await runMigration(RETUNE);
    const rows = await sentRows(id);
    expect(rows.map((r) => r.trigger)).toEqual(["-P1D"]);
  });

  it("两个老档位映射到同一个新档位时，一条 INSERT 内部不会自己撞自己", async () => {
    const id = await seedEvent({ uid: "s4", alarms: [{ trigger: "-PT5M" }, { trigger: "-PT15M" }] });
    await db.insert(schema.remindersSent).values([
      { eventId: id, trigger: "-PT5M", instanceStart: INSTANCE, sentAt: SENT },
      { eventId: id, trigger: "-PT15M", instanceStart: INSTANCE, sentAt: new Date("2026-03-01T09:00:00.000Z") },
    ]);
    await runMigration(RETUNE);
    const rows = await sentRows(id);
    const mapped = rows.filter((r) => r.trigger === "PT9H");
    expect(mapped).toHaveLength(1);
    // 留下来的是最近发过的那一条。没有这条断言的话，「留哪一条」是不确定的 ——
    // 同一条迁移在两台机器上跑出不一样的数据，是最难查的那种不一致。
    expect(mapped[0]!.sentAt.toISOString()).toBe("2026-03-01T09:00:00.000Z");
  });

  it("跑两遍不会多补行", async () => {
    const id = await seedEvent({ uid: "s5", alarms: [{ trigger: "-P1D" }] });
    await db.insert(schema.remindersSent).values({
      eventId: id, trigger: "-P1D", instanceStart: INSTANCE, sentAt: SENT,
    });
    await runMigration(RETUNE);
    const first = (await sentRows(id)).length;
    await runMigration(RETUNE);
    expect((await sentRows(id)).length).toBe(first);
  });
});

describe("0050 逼客户端重拉", () => {
  beforeEach(async () => { calendarId = await seedCalendar(); });

  it("挂了提醒的合成事件被 bump 到那个常量上", async () => {
    const id = await seedEvent({ uid: "b1", allDay: false, alarms: [{ trigger: "-PT15M" }] });
    await runMigration(RESYNC);
    expect(await updatedAtOf(id)).toBe(RESYNC_STAMP);
  });

  it("没挂提醒的事件不动 —— 它的序列化结果这一版没变", async () => {
    const id = await seedEvent({ uid: "b2", alarms: [] });
    const before = await updatedAtOf(id);
    await runMigration(RESYNC);
    expect(await updatedAtOf(id)).toBe(before);
  });

  it("raw_ics 回放的事件不动 —— bump 了就是让每台手机白下一遍", async () => {
    const id = await seedEvent({
      uid: "b3", rawIcs: "BEGIN:VEVENT\r\nUID:b3\r\nEND:VEVENT", alarms: [{ trigger: "-PT15M" }],
    });
    const before = await updatedAtOf(id);
    await runMigration(RESYNC);
    expect(await updatedAtOf(id)).toBe(before);
  });

  it("软删掉的事件不动 —— 它根本不出现在 CalDAV 响应里", async () => {
    const id = await seedEvent({
      uid: "b4", deletedAt: new Date("2026-02-01T00:00:00Z"), alarms: [{ trigger: "-PT15M" }],
    });
    const before = await updatedAtOf(id);
    await runMigration(RESYNC);
    expect(await updatedAtOf(id)).toBe(before);
  });

  it("常量之后才被编辑过的事件也要 bump —— 它手上的缓存一样是部署前那份", async () => {
    const id = await seedEvent({
      uid: "b5", alarms: [{ trigger: "-PT15M" }], updatedAt: new Date("2027-05-05T00:00:00.000Z"),
    });
    await runMigration(RESYNC);
    expect(await updatedAtOf(id)).toBe(RESYNC_STAMP);
  });

  it("跑两遍第二遍一行都不改", async () => {
    await seedEvent({ uid: "c1", alarms: [{ trigger: "-PT15M" }] });
    await seedEvent({ uid: "c2", alarms: [] });
    await seedEvent({ uid: "c3", rawIcs: "BEGIN:VEVENT\r\nEND:VEVENT", alarms: [{ trigger: "-PT15M" }] });
    await runMigration(RESYNC);
    const snap = async () =>
      (await db.select().from(schema.events)).map((r) => `${r.uid}=${r.updatedAt.toISOString()}`).sort();
    const first = await snap();
    await runMigration(RESYNC);
    expect(await snap()).toEqual(first);
  });

  it("常量没跑偏：迁移文件里写的就是测试里断言的那个时刻", async () => {
    const sql = readFileSync(RESYNC, "utf8");
    const stamps = [...sql.matchAll(/TIMESTAMPTZ '([^']+)'/g)].map((m) => m[1]!);
    expect(stamps.length, "迁移里应该恰好两处引用这个常量（SET 一处、WHERE 一处）").toBe(2);
    expect(new Set(stamps).size, "两处必须是同一个值，否则第二遍跑就不是 no-op").toBe(1);
    // '2026-09-21 02:00:00+00' → ISO：空格换 T，+00 补成 +00:00，JS 才认。
    const iso = stamps[0]!.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    expect(new Date(iso).toISOString()).toBe(RESYNC_STAMP);
  });
});

describe("两条迁移一起跑", () => {
  beforeEach(async () => { calendarId = await seedCalendar(); });

  it("0049 改过的事件，0050 一定会 bump 到 —— 否则客户端看不到改写后的 trigger", async () => {
    const id = await seedEvent({ uid: "both", alarms: [{ trigger: "-PT15M" }] });
    await runMigration(RETUNE);
    await runMigration(RESYNC);
    expect(await triggersOf(id)).toEqual(["PT9H"]);
    expect(await updatedAtOf(id)).toBe(RESYNC_STAMP);
  });
});
