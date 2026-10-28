// 后台「导入备份」到底能收多大的文件 —— 从 HTTP 打进去。
//
// ── 这条的形状 ────────────────────────────────────────────────────────
//
// 路由里写着 `if (buf.length > 100 * 1024 * 1024) ... "文件过大（>100MB）"`，
// 看上去上限是 100MB。而它用的是 `req.file()` **没带 per-request limits**，
// 于是继承全局的 2MB —— `file.toBuffer()` 在 2MB 处就抛
// RequestFileTooLargeError，那句 100MB 的判断**永远跑不到**。
//
// 后果：任何超过 2MB 的备份都导不进来，而站长看到的是 Fastify 默认的
// 英文 413 JSON，不是那句中文提示。而「导出一份备份」对任何真实站点来说
// 都远不止 2MB —— 也就是说这个功能对它的目标用户是坏的。
//
// 这就是「代码里写着一个上限、实际生效的是另一个」：两个数字都在源码里，
// 各自看都合理，只有把它们放在一起看才会发现前一个是死的。

import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { ensureSchema, resetDb, db, schema, makeUser } from "./harness.js";
import { newSessionId } from "../../src/lib/ids.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const SESSION_SECRET = process.env.SESSION_SECRET;

const { adminRoutes } = await import("../../src/web/admin.js");
const { exportData, EXPORT_TABLES, BACKUP_EXCLUDED_TABLES } = await import("../../src/lib/backup.js");

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await a.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" });
  await a.register(formbody);
  // 全局上限设成和生产一样的 2MB —— 这一档要测的正是「路由有没有自己顶掉它」。
  await a.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5 } });
  await a.register(view, {
    engine: { ejs }, root: path.resolve("src/views"), propertyName: "view",
    options: { async: false },
    defaultContext: {
      t: (k: string) => k, siteName: "ByWave", siteLogoUrl: null, icpNumber: null,
      icpUrl: "", assetVersion: "t", jsBasePath: "/static/js", cspNonce: "n",
      currentLocale: "zh-CN", locales: [], siteLocaleOptions: [], currentUser: null,
      themePalette: "indigo", themeDensity: "comfortable", currentPath: "/admin/backup",
    },
  });
  await a.register(adminRoutes);
  await a.ready();
  return a;
}

async function loginAs(userId: string) {
  const sid = newSessionId();
  await db.insert(schema.sessions).values({
    id: sid, userId, mfaSatisfied: true, expiresAt: new Date(Date.now() + 86400_000),
  });
  return {
    cookie: `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`,
    csrf: createHmac("sha256", SESSION_SECRET).update(sid).digest("hex"),
  };
}

/** 造一份合法但很大的备份 JSON。内容本身无所谓 —— 这一档测的是「收不收得下」。
 *
 *  **按实际字节数生成,不按估算。** 第一版用 `n += 1020` 估每行长度,
 *  结果要 67,633,152 字节却只生成了 67,103,735 —— 比上限还小 5KB,
 *  于是「超过上限」那条用例测的是一个没超限的文件,而它「正确地」没被拒。
 *  夹具说谎的时候,断言再严也没用。 */
function bigBackup(atLeastBytes: number): Buffer {
  const row = JSON.stringify({ note: "x".repeat(1000) });
  const head = '{"exportedAt":"2026-01-01T00:00:00Z","tables":{"notes":[';
  const tail = "]}}";
  const need = Math.max(1, Math.ceil((atLeastBytes - head.length - tail.length) / (row.length + 1)));
  const buf = Buffer.from(head + Array(need).fill(row).join(",") + tail);
  // 自检:生成出来的必须真的 >= 要求,否则这条用例什么也没测到。
  if (buf.length < atLeastBytes) {
    throw new Error(`夹具生成不足:要 ${atLeastBytes}，只生成了 ${buf.length}`);
  }
  return buf;
}

function multipartBody(filename: string, content: Buffer, csrf: string | null, fields: Record<string, string> = {}) {
  const b = "----bwc" + Math.random().toString(36).slice(2);
  // _csrf 排在文件**前面**，和真实表单一样 —— 排在后面的字段，服务端拿到文件那一刻还没解析到。
  const csrfPart = csrf === null ? "" :
    `--${b}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrf}\r\n`;
  // 其余普通字段（拦截页上的确认框）同样排在文件前面，和模板一致。
  const fieldParts = Object.entries(fields)
    .map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join("");
  const head = Buffer.from(
    csrfPart + fieldParts +
    `--${b}\r\nContent-Disposition: form-data; name="backup"; filename="${filename}"\r\n` +
    `Content-Type: application/json\r\n\r\n`,
  );
  return { payload: Buffer.concat([head, content, Buffer.from(`\r\n--${b}--\r\n`)]),
           contentType: `multipart/form-data; boundary=${b}` };
}

async function importBackup(s: { cookie: string; csrf: string | null }, content: Buffer, fields: Record<string, string> = {}) {
  const { payload, contentType } = multipartBody("backup.json", content, s.csrf, fields);
  return app.inject({
    method: "POST", url: "/admin/backup/import",
    headers: { cookie: s.cookie, "content-type": contentType },
    payload,
  });
}

beforeAll(async () => { await ensureSchema(); app = await buildApp(); });
afterAll(async () => { await app?.close(); });
beforeEach(async () => { await resetDb(); });

describe("导入备份", () => {
  it("小文件能进（presence —— 没有这条，下面那条可能只是「这条路本来就不通」）", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const res = await importBackup(s, bigBackup(1000));
    // 内容不是真的备份格式，所以会在解析/导入那一步失败 —— 但**必须是
    // 跳回后台带提示**，而不是 413。
    expect([302, 303]).toContain(res.statusCode);
  });

  it("3MB 的备份能被收下 —— 而不是撞上全局那 2MB", async () => {
    // 这才是这一档的重点。真实站点导出来的备份远不止 2MB，
    // 而路由里写着的上限是 100MB。
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const res = await importBackup(s, bigBackup(3 * 1024 * 1024));
    expect([302, 303], `回的是 ${res.statusCode}，不是跳回后台`).toContain(res.statusCode);
    // **断言必须落在「越过了大小那一关」上，不能只写「不是 413」。**
    // 第一版就是只写了 not.toBe(413) + 是跳转 —— 而把 limits 去掉之后，
    // 请求会走进「文件过大」那条 catch，同样回 302，断言照样绿。
    // A/B 当场抓到了这个洞：变异之后 4 条全过。
    const where = decodeURIComponent(String(res.headers.location));
    expect(
      where,
      "3MB 的备份被当成「过大」拒了 —— 路由没有自己的 limits，继承了全局的 2MB，" +
        "而它自己写的上限是另一个数字。真实站点导出来的备份一个都导不进来。",
    ).not.toMatch(/过大|上限/);
  });

  it("真超过上限时，给的是自己那句中文提示，不是 Fastify 的英文 413", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const { MAX_BACKUP_IMPORT_BYTES } = await import("../../src/web/admin.js");
    const res = await importBackup(s, bigBackup(MAX_BACKUP_IMPORT_BYTES + 512 * 1024));
    expect([302, 303], `超限时回的是 ${res.statusCode}，不是跳回后台`).toContain(res.statusCode);
    expect(
      decodeURIComponent(String(res.headers.location)),
      "超限时没有给出能看懂的中文提示",
    ).toMatch(/过大|上限/);
  });

  it("非管理员导不了", async () => {
    const u = await makeUser("n@example.com");
    const s = await loginAs(u.id);
    const res = await importBackup(s, bigBackup(1000));
    expect([302, 303, 403]).toContain(res.statusCode);
    expect(String(res.headers.location ?? "")).not.toContain("/admin/backup?success");
  });
});

describe("导入备份不能被同站的别的页面代发", () => {
  // 同一个上级域名下的几十个站点在浏览器眼里是「同站」，cookie 会跟着带过来。
  // 其中任何一个被攻破，就能替正在浏览的管理员导入一份伪造的备份，把整个库换掉。
  // 以前这条路不校验令牌，注释说「multipart 读不到，靠 SameSite 兜底」。
  it("**没带令牌 → 拒绝，库里什么都没变**", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const before = await db.select().from(schema.users);
    const res = await importBackup({ cookie: s.cookie, csrf: null }, bigBackup(1000));
    expect(res.statusCode, "伪造的导入请求没被拒绝 —— 整个库可以被同站页面换掉").toBe(403);
    const after = await db.select().from(schema.users);
    expect(after.length, "库被改了").toBe(before.length);
  });

  it("令牌是错的也拒绝", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const res = await importBackup({ cookie: s.cookie, csrf: "0".repeat(64) }, bigBackup(1000));
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 旧备份缺表：恢复前先拦下，站长逐张确认了才清空 —— 从 HTTP 打进去。
//
// 以前是先整库清空、恢复完再在页面上补一句「这些表现在是空的」。1.7.3 之前导出的
// 备份缺预约、预约链接、App 设备、SSO 绑定、推送订阅、OAuth 接入……站长拿它回滚
// 一次误操作，这些就永久没了，那句提示挽回不了任何东西。
// ---------------------------------------------------------------------------

describe("旧备份缺表：先拦下，站长确认了才清空", () => {
  async function seedInUse() {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const [cal] = await db.insert(schema.calendars)
      .values({ ownerId: admin.id, name: "Cal", color: "#000000", timezone: "UTC" }).returning();
    const [ev] = await db.insert(schema.events).values({
      calendarId: cal!.id, uid: "e1@example.com", summary: "季度复盘",
      startsAt: new Date("2026-07-14T01:00:00Z"), endsAt: new Date("2026-07-14T02:00:00Z"),
    }).returning();
    const [link] = await db.insert(schema.bookingLinks).values({
      userId: admin.id, calendarId: cal!.id, slug: "chat", title: "聊一聊", weeklyAvailability: {},
    }).returning();
    await db.insert(schema.bookings).values({
      linkId: link!.id, eventId: ev!.id, guestEmail: "g@example.com", guestName: "访客",
      startsAt: ev!.startsAt, endsAt: ev!.endsAt, cancelToken: "tok-cancel-1",
    });
    await db.insert(schema.devices).values({
      userId: admin.id, label: "我的 iPhone", kind: "ios",
      refreshTokenHash: "hash-1", refreshTokenPrefix: "bwd_abc12345_", lastSeenAt: new Date(),
    });
    return admin;
  }

  async function counts() {
    const n = async (t: never) => (await db.select().from(t)).length;
    return {
      users: await n(schema.users as never),
      events: await n(schema.events as never),
      bookingLinks: await n(schema.bookingLinks as never),
      bookings: await n(schema.bookings as never),
      devices: await n(schema.devices as never),
    };
  }

  /** 模拟 1.7.3 之前导出的文件：预约和设备两张表整张都没有。 */
  async function oldBackup(): Promise<Buffer> {
    const bundle = JSON.parse(JSON.stringify(await exportData()));
    delete bundle.tables.bookings;
    delete bundle.tables.devices;
    return Buffer.from(JSON.stringify(bundle));
  }

  function blockedTables(html: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const m of html.matchAll(/data-blocked-table="([^"]+)"[\s\S]*?data-blocked-rows="(\d+)"/g)) {
      out[m[1]!] = Number(m[2]);
    }
    return out;
  }

  function confirmForm(html: string): string {
    const m = /<form[^>]*id="backup-restore-confirm-form"[^>]*>([\s\S]*?)<\/form>/.exec(html);
    expect(m, "拦截页上没有确认表单 —— 站长没有办法继续").not.toBeNull();
    return m![1]!;
  }

  it("**缺表、库里有数据、没确认 → 拦下，库里一行不少**", async () => {
    const admin = await seedInUse();
    const s = await loginAs(admin.id);
    const file = await oldBackup();
    // 导出之后再多出一个用户：真恢复了的话这一行会被换掉。
    await makeUser("added-after-export@example.com");
    const before = await counts();
    expect(before.bookings, "种数据失败，下面验不出东西").toBe(1);

    const res = await importBackup(s, file);
    expect(res.statusCode, `回的是 ${res.statusCode}：${String(res.headers.location ?? "")}`).toBe(200);
    expect(await counts(), "拦下来之前库已经被清空了 —— 预约和 App 登录永久丢失").toEqual(before);
    expect(blockedTables(res.body), "页面上没列出会被清空的表和行数").toEqual({ devices: 1, bookings: 1 });
  });

  it("拦截页的确认框排在文件框前面，值盖住了全部被拦的表", async () => {
    const admin = await seedInUse();
    const res = await importBackup(await loginAs(admin.id), await oldBackup());
    const form = confirmForm(res.body);
    const confirmAt = form.search(/name="confirmEmptyTables"/);
    const fileAt = form.search(/type="file"/);
    expect(confirmAt, "确认框不见了").toBeGreaterThanOrEqual(0);
    expect(
      confirmAt < fileAt,
      "确认框排在文件框后面 —— multipart 按顺序解析，服务端拿到文件那一刻还读不到它，" +
        "站长勾了也白勾，永远恢复不了",
    ).toBe(true);
    expect(form.search(/name="_csrf"/), "确认表单没带防伪造令牌").toBeGreaterThanOrEqual(0);
    const value = /name="confirmEmptyTables"[^>]*value="([^"]*)"/.exec(form)?.[1] ?? "";
    expect(value.split(",").sort()).toEqual(["bookings", "devices"]);
  });

  it("**确认后照常恢复**：缺的两张被清空，其余原样回来，结果里点名", async () => {
    const admin = await seedInUse();
    const s = await loginAs(admin.id);
    const file = await oldBackup();
    const before = await counts();

    // 走真实流程：先被拦，再拿页面上的确认值提交。
    const blocked = await importBackup(s, file);
    const value = /name="confirmEmptyTables"[^>]*value="([^"]*)"/.exec(confirmForm(blocked.body))?.[1] ?? "";
    const res = await importBackup(s, file, { confirmEmptyTables: value });

    expect([302, 303], `确认之后回的是 ${res.statusCode}`).toContain(res.statusCode);
    const where = decodeURIComponent(String(res.headers.location));
    expect(where, "确认之后没恢复成功").toContain("success=");
    expect(where, "结果里没点名清空了哪几张").toMatch(/bookings \(1\)/);
    expect(where).toMatch(/devices \(1\)/);
    const after = await counts();
    expect(after.bookings, "确认清空的表没被清空").toBe(0);
    expect(after.devices).toBe(0);
    expect(after.users, "其余的表没按文件恢复").toBe(before.users);
    expect(after.events).toBe(before.events);
    expect(after.bookingLinks).toBe(before.bookingLinks);
  });

  it("只确认了一部分 → 照样拦，什么都不动", async () => {
    const admin = await seedInUse();
    const s = await loginAs(admin.id);
    const before = await counts();
    const res = await importBackup(s, await oldBackup(), { confirmEmptyTables: "devices" });
    expect(res.statusCode).toBe(200);
    expect(await counts(), "只确认了 devices，bookings 也跟着被清空了").toEqual(before);
    expect(Object.keys(blockedTables(res.body)).sort()).toEqual(["bookings", "devices"]);
  });

  it("缺的表库里本来就没数据 → 不拦，直接恢复", async () => {
    // 少了这条，「凡是缺表就拦」的实现也能让上面几条绿。
    const admin = await seedInUse();
    const s = await loginAs(admin.id);
    const bundle = JSON.parse(JSON.stringify(await exportData()));
    delete bundle.tables.push_subscriptions;   // 种数据时没建过推送订阅
    const res = await importBackup(s, Buffer.from(JSON.stringify(bundle)));
    expect([302, 303], `回的是 ${res.statusCode}，没东西可丢也被拦了`).toContain(res.statusCode);
    expect(decodeURIComponent(String(res.headers.location))).toContain("success=");
  });
});

describe("备份页上的表清单", () => {
  it("**就是代码里那两张清单** —— 不是语言包里写死的旧 15 张", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const res = await app.inject({ method: "GET", url: "/admin/backup", headers: { cookie: s.cookie } });
    expect(res.statusCode).toBe(200);
    const list = (id: string) => {
      const m = new RegExp(`<li id="${id}">[\\s\\S]*?<span class="font-mono[^"]*">([^<]*)</span>`).exec(res.body);
      expect(m, `页面上没有 #${id}`).not.toBeNull();
      return m![1]!.split(" · ").map((x) => x.trim()).filter(Boolean).sort();
    };
    expect(
      list("backup-included-tables"),
      "页面上「包含的表」和 EXPORT_TABLES 对不上 —— 站长照着它判断预约在不在备份里，会得到错的答案",
    ).toEqual(EXPORT_TABLES.map((t) => t.name).sort());
    expect(list("backup-excluded-tables")).toEqual([...BACKUP_EXCLUDED_TABLES].sort());
  });
});

