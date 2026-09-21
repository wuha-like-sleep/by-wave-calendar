// 参与者取值的唯一事实源。
//
// 为什么要单独开一个模块（和 reminder_triggers 是同一个套路：一种值一个模块）：
// 在这之前，「一个事件的参与者是什么」在库里有**两种互不兼容的形状**，而且是谁写的
// 谁说了算 ——
//
//   CalDAV / .ics 那一路（ical.ts parseEvent）存的是对象数组：
//     [{ email: "a@x.com", cn: "Alice", role: "REQ-PARTICIPANT", partstat: "ACCEPTED" }]
//   网页 / JSON API 那一路（routes/events.ts、web/index.ts、booking.ts）存的是字符串数组：
//     ["a@x.com"]
//
// 三个已经复现出来的用户可见后果，全是「没人报错，东西就是不对」：
//
//   ① 手机上加的参与者，网页保存一次就全没了。网页把 extra.attendees 直接 join(",")
//      填进输入框，对象数组 join 出来是 "[object Object],[object Object]"，提交时
//      parseEmails 一个都留不下，于是发一个 null 上来，把整个键删掉。
//   ② 网页加的参与者在 iPhone 日历里根本不显示：serializeEvent 里那行
//      `if (!a.email) continue` 对字符串恒为真，ATTENDEE 一行都不发。
//   ③ 对手机同步来的事件点「移除参与者」永远删不掉、点「邀请」还会重复发一封邮件：
//      两处都是 `current.includes(email)` / `filter(e => e !== email)`，
//      对对象数组恒为 false。
//
// 收口口径：
//   **存进 extra.attendees 的唯一形状 = 小写去重后的邮箱字符串数组**（attendeeEmails 的输出）。
//   选字符串而不是对象，理由是已经发出去的客户端只认字符串：桌面端的
//   Models.kt 里 `attendees: List<String>?` 是 kotlinx 的强类型字段，
//   服务端吐一个对象数组过去，**整份事件列表**当场反序列化失败（不是少显示一个参与者，
//   是这个日历打不开）。这些包已经在用户手上，改不了。
//   代价是 CN / ROLE / PARTSTAT 不进 extra：
//     - CN：只在「这个事件被网页改过、rawIcs 被清掉了」之后才会丢，正常同步的事件
//       GET 回放的是原始 VEVENT，显示名一直在；
//     - PARTSTAT：真正的事实源是 event_invite_tokens.response_status，
//       caldav.ts 的 loadAttendeeStatuses 每次 GET 都会覆盖回去，存在 extra 里反而是旧的；
//     - ROLE：我们没有任何一处读它。
//
// 读侧一律走这里的两个函数，不要再各自 `Array.isArray(extra.attendees)` ——
// 那正是上面三个 bug 的共同写法。

/** 库里 / 请求体里可能出现的参与者写法。两种都要吃得下。 */
export type AttendeeLike =
  | string
  | { email?: unknown; cn?: unknown; role?: unknown; partstat?: unknown };

/** 序列化 ATTENDEE 行需要的形状。 */
export type AttendeeDetail = {
  email: string;
  cn?: string | null;
  role?: string | null;
  partstat?: string | null;
};

// 和网页那份 parseEmails（src/public/calendar-app.js）用同一条判据。
// 两边口径必须一致：服务端留下了而网页留不下的值，会在用户下一次保存时被悄悄丢掉，
// 也就是本模块要修的 bug ① 换个形状再来一遍。
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // CalDAV 的 ATTENDEE 值是 "mailto:a@x.com"；ical.ts 剥过一次前缀，
  // 但 .ics 导入和第三方写入不一定剥干净，这里再兜一层。
  const v = raw.trim().replace(/^mailto:/i, "").trim().toLowerCase();
  if (!v || !EMAIL_RE.test(v)) return null;
  return v;
}

function optText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v ? v : null;
}

/**
 * 读侧（带显示参数）：把任意一种存量形状摊成 ATTENDEE 行需要的样子。
 *
 * - 字符串项 → 只有 email，CN/ROLE/PARTSTAT 交给 serializeEvent 取默认值；
 * - 对象项 → 保留 cn / role / partstat；
 * - 不是邮箱的一律丢掉（`urn:uuid:…`、`/principals/…` 这类 iOS 内部身份我们既发不了
 *   邮件也显示不出人名，留着只会变成一行发不出去的 ATTENDEE）；
 * - 按邮箱去重，保留第一次出现的顺序和参数。
 */
export function attendeeDetails(value: unknown): AttendeeDetail[] {
  if (!Array.isArray(value)) return [];
  const out: AttendeeDetail[] = [];
  const seen = new Set<string>();
  for (const item of value as AttendeeLike[]) {
    const email = cleanEmail(typeof item === "string" ? item : (item as { email?: unknown })?.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (typeof item === "string") {
      out.push({ email });
    } else {
      out.push({
        email,
        cn: optText(item?.cn),
        role: optText(item?.role),
        partstat: optText(item?.partstat),
      });
    }
  }
  return out;
}

/**
 * 读侧（只要邮箱）**也是写侧的规范化**：存进 extra.attendees 的就是这个函数的输出。
 *
 * 两件事用同一个函数是故意的 —— 读和写各写一遍过滤规则，就会出现「存下去的值
 * 自己读不回来」这类只有存量数据才踩得到的差。
 */
export function attendeeEmails(value: unknown): string[] {
  return attendeeDetails(value).map((a) => a.email);
}

/**
 * extra 整块的存量形状归一：目前只有 attendees 一个键需要，但入口留在这里，
 * 免得下一个「两种形状」的键又各改各的。
 *
 * 用在**发给客户端之前**：库里那些 CalDAV 写进去的对象数组，在被任何一次写入
 * 改写成字符串数组之前，都还会原样躺在 JSONB 里，而桌面端 / 安卓拿到对象数组
 * 是整份列表反序列化失败。返回值是新对象，不改传进来的那份。
 */
export function normalizeExtraForClients(extra: unknown): unknown {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return extra;
  const src = extra as Record<string, unknown>;
  if (!Array.isArray(src.attendees)) return extra;
  const emails = attendeeEmails(src.attendees);
  // 本来就是规范形状（最常见的情况）就原样返回，别白建一个对象。
  const already = src.attendees.length === emails.length
    && src.attendees.every((a, i) => a === emails[i]);
  if (already) return extra;
  return { ...src, attendees: emails };
}
