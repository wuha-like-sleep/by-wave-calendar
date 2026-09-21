// Minimal iCalendar (RFC 5545) parser and serializer for CalDAV.
// Handles the subset of properties our calendar app supports: UID, SUMMARY,
// DESCRIPTION, LOCATION, DTSTART/DTEND (date + datetime, UTC + floating),
// CREATED, LAST-MODIFIED, DTSTAMP, RRULE.

import { getBrandName } from "./email_templates.js";
import { normalizeAlarms } from "./reminder_triggers.js";
import { attendeeDetails, type AttendeeLike } from "./attendees.js";

// PRODID identifies the generating product. Derive it from the site brand so a
// self-hosted / white-labelled deploy stamps ITS OWN name into every .ics it
// emits, not "ByWave-Calendar". RFC 5545 allows UTF-8 here; we only strip the
// few chars that would break the property line, and fall back to a default.
export function prodIdLine(part: "CalDAV" | "Invite"): string {
  const name = getBrandName().replace(/[;,\\\r\n]/g, " ").trim() || "ByWave-Calendar";
  return `PRODID:-//${name}//${part}//EN`;
}

export type IcalAttendee = { email: string; cn?: string | null; role?: string | null; partstat?: string | null };
export type IcalAlarm = { trigger: string; action?: string | null; description?: string | null };

export type IcalEvent = {
  uid: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  rrule?: string | null;
  // EXDATE values — ISO 8601 strings (UTC). When a client deletes "just this
  // occurrence" of a recurring event, the master VEVENT lists the excluded
  // instance starts here. Round-trip through CalDAV so iOS/macOS calendars
  // stay in sync with the web "delete just this occurrence" feature.
  exdates?: string[] | null;
  // The IANA zone this event is anchored to (parsed from DTSTART;TZID=…
  // on input, used to emit DTSTART;TZID=… on output). The Date fields
  // above are always UTC instants; this just remembers which wall-clock
  // they were created in.
  timezone?: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  transp?: string | null;
  status?: string | null;
  categories?: string[] | null;
  organizer?: string | null;
  // 两种存量形状都收：CalDAV 存的是 {email,cn,role,partstat} 对象数组，
  // 网页 / JSON API 存的是邮箱字符串数组。序列化时统一过 attendeeDetails，
  // 否则字符串那一路会被下面的 `!a.email` 整组跳过 —— 网页加的参与者在
  // iPhone 日历里一个都不显示，正是这么来的。
  attendees?: AttendeeLike[] | null;
  alarms?: IcalAlarm[] | null;
};

// Extract the raw "BEGIN:VEVENT…END:VEVENT" block (incl. nested VALARMs) from an
// inbound iCalendar body. Returns the canonical text we'll round-trip back to
// clients so non-parsed properties (ATTENDEE, VALARM, TRANSP, CATEGORIES, X-*)
// survive a server-side round-trip.
export function extractVeventBlock(ics: string): string | null {
  const unfolded = ics.replace(/\r?\n[\t ]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const start = lines.findIndex((l) => l.toUpperCase() === "BEGIN:VEVENT");
  if (start < 0) return null;
  // Find the matching END:VEVENT — VALARM may be nested but uses END:VALARM (not VEVENT).
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if ((lines[i] ?? "").toUpperCase() === "END:VEVENT") { end = i; break; }
  }
  if (end < 0) return null;
  return lines.slice(start, end + 1).join(CRLF);
}

const CRLF = "\r\n";

function pad(n: number): string { return String(n).padStart(2, "0"); }

function formatDateTime(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

// Render a UTC Date as wall-clock YYYYMMDDTHHMMSS in the target IANA zone.
// Used to emit DTSTART;TZID=Asia/Shanghai:20260601T180000 (no trailing Z).
// Falls back to UTC if the zone is unknown — better than throwing.
function formatWallClockInZone(d: Date, tzid: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    // Intl renders midnight as "24" in some locales; normalize to "00".
    let hh = get("hour"); if (hh === "24") hh = "00";
    return `${get("year")}${get("month")}${get("day")}T${hh}${get("minute")}${get("second")}`;
  } catch {
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  }
}

function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function unescapeText(s: string): string {
  return s
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// Fold a single content-line per RFC 5545 (CRLF + space for continuation).
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) {
    const len = i === 0 ? 75 : 74;
    parts.push((i === 0 ? "" : " ") + line.slice(i, i + len));
    i += len;
  }
  return parts.join(CRLF);
}

export function serializeEvent(event: IcalEvent): string {
  const lines: string[] = [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${formatDateTime(event.updatedAt ?? new Date())}`,
  ];
  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatDate(event.startsAt)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDate(event.endsAt)}`);
  } else if (event.timezone) {
    // Emit wall-clock in the event's zone with TZID parameter. iOS /
    // macOS / Google / Outlook all render this as "this is 6pm Shanghai
    // time" — phone shifts the display when the user travels, instead
    // of statically showing the UTC equivalent. We don't emit a full
    // VTIMEZONE block — modern clients use the IANA database directly
    // and tolerate a missing VTIMEZONE per RFC 7986 / common practice.
    const wall = formatWallClockInZone(event.startsAt, event.timezone);
    const wallEnd = formatWallClockInZone(event.endsAt, event.timezone);
    lines.push(`DTSTART;TZID=${event.timezone}:${wall}`);
    lines.push(`DTEND;TZID=${event.timezone}:${wallEnd}`);
  } else {
    lines.push(`DTSTART:${formatDateTime(event.startsAt)}`);
    lines.push(`DTEND:${formatDateTime(event.endsAt)}`);
  }
  lines.push(`SUMMARY:${escapeText(event.summary)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.rrule) lines.push(`RRULE:${event.rrule}`);
  // ORGANIZER + ATTENDEE for events that have them. CalDAV clients
  // (iOS Calendar, macOS Calendar, Thunderbird) display these as the
  // attendee list and surface the organizer's name on the event card.
  // Without this, web-UI-created events look "naked" on the phone.
  if (event.organizer) {
    lines.push(`ORGANIZER:mailto:${event.organizer}`);
  }
  for (const a of attendeeDetails(event.attendees)) {
    const cn = a.cn ? `;CN=${escapeText(a.cn)}` : "";
    const role = a.role ? `;ROLE=${a.role}` : ";ROLE=REQ-PARTICIPANT";
    const partstat = a.partstat ? `;PARTSTAT=${a.partstat}` : ";PARTSTAT=NEEDS-ACTION";
    lines.push(`ATTENDEE${cn}${role}${partstat};RSVP=TRUE:mailto:${a.email}`);
  }
  // EXDATE: one line per excluded instance (some clients merge them into
  // a comma-joined list, but per-line is universally accepted and easier
  // to debug). Match the all-day form when the master is all-day so the
  // exclusion semantics line up — otherwise emit datetime+Z.
  if (event.exdates && event.exdates.length > 0) {
    for (const iso of event.exdates) {
      const d = new Date(iso);
      if (isNaN(d.getTime())) continue;
      if (event.allDay) {
        lines.push(`EXDATE;VALUE=DATE:${formatDate(d)}`);
      } else {
        lines.push(`EXDATE:${formatDateTime(d)}`);
      }
    }
  }
  if (event.createdAt) lines.push(`CREATED:${formatDateTime(event.createdAt)}`);
  if (event.updatedAt) lines.push(`LAST-MODIFIED:${formatDateTime(event.updatedAt)}`);
  // VALARM。这条不是「顺手补全」：PUT 那边已经改成「整份 VEVENT 上传，没有 VALARM
  // 就是用户把提醒删了」。合成出来的 VEVENT（网页/API 建的事件，没有 rawIcs 可回放）
  // 如果不带 VALARM，手机就从没见过这条提醒，它一回写就把提醒清掉 —— 等于用户在网页上
  // 设的提醒，只要在手机上碰一下这个事件就没了，而且两端都不报错。
  // 再过一遍 normalizeAlarms：库里可能留着历史遗留的垃圾 trigger，吐一条客户端解析
  // 不了的 VALARM 出去，有的客户端会整份事件拒收。
  for (const alarm of normalizeAlarms(event.alarms ?? [])) {
    const { params, value } = splitTriggerParams(alarm.trigger);
    const action = (alarm.action ?? "").toUpperCase();
    lines.push("BEGIN:VALARM");
    // ACTION 只回放 DISPLAY / AUDIO。EMAIL 提醒按 RFC 5545 还必须带 SUMMARY 和
    // ATTENDEE，我们这条合成路径上没有这些值，与其发一份不合法的 VALARM，
    // 不如降级成 DISPLAY —— 用户照样在手机上收到提醒。
    lines.push(`ACTION:${action === "AUDIO" ? "AUDIO" : "DISPLAY"}`);
    lines.push(`DESCRIPTION:${escapeText(alarm.description || event.summary)}`);
    lines.push(`TRIGGER${params ? `;${params}` : ""}:${value}`);
    lines.push("END:VALARM");
  }
  lines.push("END:VEVENT");
  return lines.map(foldLine).join(CRLF);
}

export function serializeCalendar(events: IcalEvent[], calendarName: string): string {
  const inner = events.map(serializeEvent).join(CRLF);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    prodIdLine("CalDAV"),
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    inner,
    "END:VCALENDAR",
  ].join(CRLF) + CRLF;
}

export function invitationIcs(opts: {
  event: IcalEvent;
  organizerEmail: string;
  organizerName?: string;
  attendees: { email: string; cn?: string }[];
  calendarName?: string;
  sequence?: number;
  method?: "REQUEST" | "CANCEL" | "PUBLISH";
}): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    prodIdLine("Invite"),
    "CALSCALE:GREGORIAN",
    `METHOD:${opts.method ?? "REQUEST"}`,
    ...(opts.calendarName ? [`X-WR-CALNAME:${escapeText(opts.calendarName)}`] : []),
    "BEGIN:VEVENT",
    `UID:${opts.event.uid}`,
    `DTSTAMP:${formatDateTime(opts.event.updatedAt ?? new Date())}`,
  ];
  if (opts.event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatDate(opts.event.startsAt)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDate(opts.event.endsAt)}`);
  } else {
    lines.push(`DTSTART:${formatDateTime(opts.event.startsAt)}`);
    lines.push(`DTEND:${formatDateTime(opts.event.endsAt)}`);
  }
  lines.push(`SUMMARY:${escapeText(opts.event.summary)}`);
  if (opts.event.location) lines.push(`LOCATION:${escapeText(opts.event.location)}`);
  if (opts.event.description) lines.push(`DESCRIPTION:${escapeText(opts.event.description)}`);
  if (opts.event.rrule) lines.push(`RRULE:${opts.event.rrule}`);
  const orgCn = opts.organizerName ? `;CN=${escapeText(opts.organizerName)}` : "";
  lines.push(`ORGANIZER${orgCn}:mailto:${opts.organizerEmail}`);
  for (const a of opts.attendees) {
    const cn = a.cn ? `;CN=${escapeText(a.cn)}` : "";
    lines.push(`ATTENDEE${cn};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`);
  }
  lines.push(`SEQUENCE:${opts.sequence ?? 0}`);
  lines.push("STATUS:CONFIRMED");
  lines.push("TRANSP:OPAQUE");
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}

export function wrapSingleEvent(event: IcalEvent, calendarName: string = ""): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    prodIdLine("CalDAV"),
    "CALSCALE:GREGORIAN",
    ...(calendarName ? [`X-WR-CALNAME:${escapeText(calendarName)}`] : []),
    serializeEvent(event),
    "END:VCALENDAR",
  ].join(CRLF) + CRLF;
}

// ---------- Parser ----------

type ParsedLine = { params: Record<string, string>; value: string };

function parsePropLine(line: string): { name: string; line: ParsedLine } | null {
  const colonIdx = line.indexOf(":");
  if (colonIdx < 0) return null;
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const segments = head.split(";");
  const name = (segments[0] ?? "").toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of segments.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name, line: { params, value } };
}

// TRIGGER 的参数不能只取 value 就扔掉。RELATED=END 决定这条提醒是按事件**结束**还是
// 按开始算，VALUE=DATE-TIME 决定后面那串是绝对时刻还是相对时长。原先只取 value：
// 「结束前 15 分钟」被静默当成「开始前 15 分钟」（一场 2 小时的会提前 2 小时响），
// 绝对触发则因为解析不出 duration 被整条丢掉，用户永远等不到那条提醒。
// 拼回 "RELATED=END:-PT15M" 这种带参数前缀的原样，reminder_triggers.parseTrigger 直接能吃，
// 也就不用在这里各剥各的（剥错的代价同样是整条提醒消失）。
function triggerWithParams(line: ParsedLine): string {
  const params = Object.entries(line.params).map(([k, v]) => `${k}=${v}`);
  return params.length ? `${params.join(";")}:${line.value}` : line.value;
}

// 把存着的 trigger 原文拆回「参数区 / 值」，用来重新拼一行 TRIGGER 属性。
// 判据和 parseTrigger 保持一致：只有第一个冒号之前那段含 "=" 才算参数区，
// 否则整串都是值（免得 "banana:x" 被当成参数化写法）。
function splitTriggerParams(raw: string): { params: string; value: string } {
  const text = raw.replace(/^\s*TRIGGER[;:]/i, "").trim();
  const colon = text.indexOf(":");
  if (colon > 0 && text.slice(0, colon).includes("=")) {
    return { params: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim() };
  }
  return { params: "", value: text };
}

export function parseEvent(ics: string): IcalEvent | null {
  // Unfold continuation lines (CRLF + space or tab).
  const unfolded = ics.replace(/\r?\n[\t ]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const start = lines.findIndex((l) => l.toUpperCase() === "BEGIN:VEVENT");
  const end = lines.findIndex((l) => l.toUpperCase() === "END:VEVENT");
  if (start < 0 || end < 0 || end <= start) return null;

  const singleProps: Record<string, ParsedLine> = {};
  const attendees: IcalAttendee[] = [];
  const alarms: IcalAlarm[] = [];
  // EXDATE is allowed multiple times AND each line is a comma-separated list,
  // so we collect ISO strings as we walk the body rather than overwriting in
  // singleProps. RFC 5545 §3.8.5.1.
  const exdates: string[] = [];
  let organizer: string | null = null;
  let categories: string[] | null = null;

  let i = start + 1;
  while (i < end) {
    const line = lines[i] ?? "";
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VALARM") {
      const alarmEnd = lines.findIndex((l, idx) => idx > i && l.toUpperCase() === "END:VALARM");
      const blockEnd = alarmEnd > 0 ? alarmEnd : end;
      const alarmProps: Record<string, ParsedLine> = {};
      for (let j = i + 1; j < blockEnd; j++) {
        const parsed = parsePropLine(lines[j] ?? "");
        if (parsed) alarmProps[parsed.name] = parsed.line;
      }
      const trigger = alarmProps["TRIGGER"];
      if (trigger) {
        alarms.push({
          trigger: triggerWithParams(trigger),
          action: alarmProps["ACTION"]?.value ?? null,
          description: alarmProps["DESCRIPTION"] ? unescapeText(alarmProps["DESCRIPTION"].value) : null,
        });
      }
      i = blockEnd + 1;
      continue;
    }
    const parsed = parsePropLine(line);
    if (!parsed) { i++; continue; }
    if (parsed.name === "EXDATE") {
      // Comma-separated list of timestamps OR dates. The VALUE=DATE
      // parameter (or a no-time YYYYMMDD string) means an all-day
      // exclusion; otherwise treat as datetime. TZID respected the
      // same way DTSTART handles it.
      const isAllDay = parsed.line.params["VALUE"] === "DATE";
      const tzid = parsed.line.params["TZID"];
      for (const raw of parsed.line.value.split(",")) {
        const v = raw.trim();
        if (!v) continue;
        try {
          const d = parseICalDateValue(v, isAllDay || v.length === 8, tzid);
          if (!isNaN(d.getTime())) exdates.push(d.toISOString());
        } catch { /* skip malformed exdate, don't fail whole parse */ }
      }
      i++;
      continue;
    }
    if (parsed.name === "ATTENDEE") {
      const v = parsed.line.value || "";
      const email = v.toLowerCase().startsWith("mailto:") ? v.slice(7) : v;
      attendees.push({
        email,
        cn: parsed.line.params["CN"] ?? null,
        role: parsed.line.params["ROLE"] ?? null,
        partstat: parsed.line.params["PARTSTAT"] ?? null,
      });
    } else if (parsed.name === "ORGANIZER") {
      const v = parsed.line.value || "";
      organizer = v.toLowerCase().startsWith("mailto:") ? v.slice(7) : v;
    } else if (parsed.name === "CATEGORIES") {
      categories = parsed.line.value.split(",").map((s) => unescapeText(s.trim())).filter(Boolean);
    } else {
      singleProps[parsed.name] = parsed.line;
    }
    i++;
  }

  const uid = singleProps["UID"]?.value;
  const summary = singleProps["SUMMARY"]?.value;
  const dtstart = singleProps["DTSTART"];
  const dtend = singleProps["DTEND"];
  if (!uid || !summary || !dtstart || !dtend) return null;

  const allDay = dtstart.params["VALUE"] === "DATE";
  const startTzid = dtstart.params["TZID"];
  const endTzid = dtend.params["TZID"];

  // 第三方来源的口径（CalDAV PUT / .ics 导入）：解析不了的那一条丢掉，其余保留，
  // 不要因为一条 TRIGGER 写坏了就整份事件 400 —— 这些客户端我们控制不了，
  // 拒收的结果是用户的事件在手机上标红「无法同步」，比少一条提醒糟得多。
  // 去重和 8 条上限也在这里一并做掉（同 trigger 两条会在同一分钟响两次，
  // 而幂等键 (event_id, trigger, instance_start) 因为原文不同挡不住）。
  const cleanAlarms = normalizeAlarms(alarms);

  return {
    uid: uid.trim(),
    summary: unescapeText(summary),
    description: singleProps["DESCRIPTION"] ? unescapeText(singleProps["DESCRIPTION"].value) : null,
    location: singleProps["LOCATION"] ? unescapeText(singleProps["LOCATION"].value) : null,
    startsAt: parseICalDateValue(dtstart.value, allDay, startTzid),
    endsAt: parseICalDateValue(dtend.value, allDay, endTzid),
    allDay,
    rrule: singleProps["RRULE"]?.value ?? null,
    exdates: exdates.length ? exdates : null,
    // Capture the TZID parameter from DTSTART for round-trip preservation.
    // We don't try to merge start vs end TZID — an event spanning timezones
    // is rare and CalDAV clients all use DTSTART's TZID for display anyway.
    timezone: startTzid ?? null,
    createdAt: singleProps["CREATED"] ? parseICalDateValue(singleProps["CREATED"].value, false) : null,
    updatedAt: singleProps["LAST-MODIFIED"] ? parseICalDateValue(singleProps["LAST-MODIFIED"].value, false) : null,
    transp: singleProps["TRANSP"]?.value?.toUpperCase() ?? null,
    status: singleProps["STATUS"]?.value?.toUpperCase() ?? null,
    categories: categories && categories.length ? categories : null,
    organizer,
    attendees: attendees.length ? attendees : null,
    alarms: cleanAlarms.length ? cleanAlarms : null,
  };
}

export function parseEvents(ics: string): IcalEvent[] {
  // Unfold once, then walk the lines collecting every VEVENT block.
  const unfolded = ics.replace(/\r?\n[\t ]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const events: IcalEvent[] = [];
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] ?? "").toUpperCase() === "BEGIN:VEVENT") {
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? "").toUpperCase() !== "END:VEVENT") j++;
      if (j >= lines.length) break;
      const block = lines.slice(i, j + 1).join(CRLF);
      const ev = parseEvent(block);
      if (ev) events.push(ev);
      i = j + 1;
    } else {
      i++;
    }
  }
  return events;
}

function parseICalDateValue(val: string, allDay: boolean, tzid?: string): Date {
  if (allDay) {
    const y = Number(val.slice(0, 4));
    const m = Number(val.slice(4, 6)) - 1;
    const d = Number(val.slice(6, 8));
    return new Date(Date.UTC(y, m, d));
  }
  const y = Number(val.slice(0, 4));
  const mo = Number(val.slice(4, 6)) - 1;
  const d = Number(val.slice(6, 8));
  const h = Number(val.slice(9, 11));
  const mi = Number(val.slice(11, 13));
  const s = Number(val.slice(13, 15) || "0");
  // Trailing Z → UTC. TZID parameter → IANA-zone wall clock. Otherwise floating
  // (best-effort: treat as UTC; matches what most clients want for sync).
  const isUtc = val.endsWith("Z");
  if (isUtc || !tzid) {
    return new Date(Date.UTC(y, mo, d, h, mi, s));
  }
  return wallClockInZoneToUtc(y, mo, d, h, mi, s, tzid);
}

// Treat (y, mo, d, h, mi, s) as a wall-clock reading in `tzid` and return the UTC
// instant that produces that reading. Uses Intl.DateTimeFormat to determine the
// zone offset at the target time (handles DST automatically).
function wallClockInZoneToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tzid: string): Date {
  // First guess: assume the components are UTC. Find what that instant reads as
  // in tzid, compute the delta, then correct.
  const utcGuess = Date.UTC(y, mo, d, h, mi, s);
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(utcGuess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    // Intl uses "24" for midnight in some locales; normalize to 0.
    let hh = get("hour"); if (hh === 24) hh = 0;
    const tzReading = Date.UTC(get("year"), get("month") - 1, get("day"), hh, get("minute"), get("second"));
    const offsetMs = tzReading - utcGuess;
    return new Date(utcGuess - offsetMs);
  } catch {
    return new Date(utcGuess); // unknown zone → fall back to UTC interpretation
  }
}
