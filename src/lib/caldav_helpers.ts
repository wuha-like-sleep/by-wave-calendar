// Pure helpers for CalDAV body manipulation. Extracted from web/caldav.ts
// so they can be unit-tested without spinning up a Fastify instance or a DB.
//
// Both helpers operate on string text — never touch the DB or the network.
// Keep them dependency-free.

// Replace PARTSTAT= on ATTENDEE lines whose mailto: matches a known RSVP
// response. This is how the organizer's iOS Calendar learns that
// "alice@x.com clicked Accept on the email" — without it, the phone keeps
// showing NEEDS-ACTION forever even though our DB has the answer.
//
// `byEmail` is a Map from lower-cased recipient email → PARTSTAT value
// (e.g. "ACCEPTED", "DECLINED", "TENTATIVE"). Lines whose email isn't in
// the map pass through unchanged.
export function overlayPartstat(vevent: string, byEmail: Map<string, string>): string {
  if (byEmail.size === 0) return vevent;
  // Whole-line match: ATTENDEE[;params]:mailto:foo@bar
  return vevent.replace(
    /^(ATTENDEE[^\r\n]*?):mailto:([^\s\r\n;]+)/gim,
    (full: string, head: string, email: string) => {
      const newStat = byEmail.get(email.toLowerCase());
      if (!newStat) return full;
      const updatedHead = /;PARTSTAT=/i.test(head)
        ? head.replace(/;PARTSTAT=[^;]*/i, `;PARTSTAT=${newStat}`)
        : `${head};PARTSTAT=${newStat}`;
      return `${updatedHead}:mailto:${email}`;
    },
  );
}

// Strip any EXDATE lines from the raw VEVENT and re-inject the current
// authoritative list. The rawIcs snapshot is taken at PUT time, but
// events.exdates can be modified later via the web UI's "delete just this
// occurrence" — we want CalDAV clients to see the latest.
//
// `row` only needs the bits we use; pass `{ exdates, allDay }` to avoid
// dragging the full Drizzle Event type into this lib (keeps the helper
// usable in tests without DB types).
export function mergeExdatesIntoVevent(
  rawVevent: string,
  row: { exdates?: string[] | null; allDay?: boolean | null },
): string {
  const exdates = Array.isArray(row.exdates) ? row.exdates : [];
  // Fast path: no exdates AND the raw body has none → unchanged.
  const hasRawExdate = /\r?\nEXDATE[;:]/i.test(rawVevent);
  if (exdates.length === 0 && !hasRawExdate) return rawVevent;

  const CRLF = "\r\n";
  // Unfold continuation lines so we can identify whole EXDATE properties.
  const unfolded = rawVevent.replace(/\r?\n[\t ]/g, "");
  const lines = unfolded.split(/\r?\n/).filter((l) => !/^EXDATE[;:]/i.test(l));
  const endIdx = lines.findIndex((l) => l.toUpperCase() === "END:VEVENT");
  if (endIdx < 0) return rawVevent;
  const injected: string[] = [];
  const isAllDay = !!row.allDay;
  const pad = (n: number) => String(n).padStart(2, "0");
  for (const iso of exdates) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) continue;
    if (isAllDay) {
      injected.push(
        `EXDATE;VALUE=DATE:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`,
      );
    } else {
      injected.push(
        `EXDATE:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`,
      );
    }
  }
  const merged = [...lines.slice(0, endIdx), ...injected, ...lines.slice(endIdx)];
  return merged.join(CRLF);
}

// ---------- 条件请求：If-Match / If-None-Match 的判定 ----------
//
// CalDAV 冲突模型里「客户端明示了前置条件」的那一半，全在这里：
// 客户端把条件写在头里，就是明确在说「我这份写只在某个前提下成立」。
// 服务端无视它、照样覆盖或插入，是所有静默丢数据里最不可原谅的一种——
// 不是客户端没保护自己，是它保护了、我们没听。
//
// 判定口径（RFC 7232 §3.1 / §3.2，落到我们的资源模型上）：
//   · currentEtag 是「资源当前 etag」；资源不存在（没有行，或只有软删行——
//     GET 对软删行回 404，客户端眼里它就是不存在）时传 null。
//   · If-Match：头不存在 → 不约束；资源不存在 → 任何 If-Match 都不成立
//     （含 `*`：`*` 的意思就是「必须存在」）；资源存在 → 列表里含 `*`
//     或含当前 etag 才成立。
//   · If-None-Match：头不存在 → 不约束；资源不存在 → 恒成立（`*` 正是
//     create-only 的标准写法）；资源存在 → 列表里含 `*` 或含当前 etag
//     则**不成立**。
//
// etag 比对的归一化与 calendar_ctag.ts 的 etagMatches 同一套：逗号列表
// 逐个比、弱前缀 `W/` 剥掉再比。RFC 7232 严格说 If-Match 不许弱比对，
// 但我们从不签发弱 etag——`W/` 只会是中间的反向代理开 gzip 时改写的
// （见 etagMatches 的注释和 series_edit 的 304 用例）。值一字不差、
// 只是被代理贴了个前缀，因为这个把用户的正常保存打成 412，才是真丢数据。
// 保护的实质——「写方必须出示当前 etag 的值」——一点没让。

function splitEtagHeader(header: string): string[] {
  return header
    .split(",")
    .map((h) => h.trim().replace(/^W\//, ""))
    .filter((h) => h.length > 0);
}

/** If-Match 头是否允许这次写。header 为 undefined（没带）= 不约束，恒 true。 */
export function ifMatchAllows(header: string | undefined, currentEtag: string | null): boolean {
  if (header === undefined) return true;
  const list = splitEtagHeader(header);
  if (list.length === 0) return true;
  if (currentEtag === null) return false;
  return list.some((t) => t === "*" || t === currentEtag);
}

/** If-None-Match 头是否允许这次写。header 为 undefined（没带）= 不约束，恒 true。 */
export function ifNoneMatchAllows(header: string | undefined, currentEtag: string | null): boolean {
  if (header === undefined) return true;
  const list = splitEtagHeader(header);
  if (list.length === 0) return true;
  if (currentEtag === null) return true;
  return !list.some((t) => t === "*" || t === currentEtag);
}
