// Minimal iCalendar (RFC 5545) parser and serializer for CalDAV.
// Handles the subset of properties our calendar app supports: UID, SUMMARY,
// DESCRIPTION, LOCATION, DTSTART/DTEND (date + datetime, UTC + floating),
// CREATED, LAST-MODIFIED, DTSTAMP, RRULE.

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
  createdAt?: Date | null;
  updatedAt?: Date | null;
  transp?: string | null;
  status?: string | null;
  categories?: string[] | null;
  organizer?: string | null;
  attendees?: IcalAttendee[] | null;
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
  } else {
    lines.push(`DTSTART:${formatDateTime(event.startsAt)}`);
    lines.push(`DTEND:${formatDateTime(event.endsAt)}`);
  }
  lines.push(`SUMMARY:${escapeText(event.summary)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.rrule) lines.push(`RRULE:${event.rrule}`);
  if (event.createdAt) lines.push(`CREATED:${formatDateTime(event.createdAt)}`);
  if (event.updatedAt) lines.push(`LAST-MODIFIED:${formatDateTime(event.updatedAt)}`);
  lines.push("END:VEVENT");
  return lines.map(foldLine).join(CRLF);
}

export function serializeCalendar(events: IcalEvent[], calendarName: string): string {
  const inner = events.map(serializeEvent).join(CRLF);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ByWave-Calendar//CalDAV//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    inner,
    "END:VCALENDAR",
  ].join(CRLF) + CRLF;
}

export function wrapSingleEvent(event: IcalEvent, calendarName: string = ""): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ByWave-Calendar//CalDAV//EN",
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
      const trigger = alarmProps["TRIGGER"]?.value;
      if (trigger) {
        alarms.push({
          trigger,
          action: alarmProps["ACTION"]?.value ?? null,
          description: alarmProps["DESCRIPTION"] ? unescapeText(alarmProps["DESCRIPTION"].value) : null,
        });
      }
      i = blockEnd + 1;
      continue;
    }
    const parsed = parsePropLine(line);
    if (!parsed) { i++; continue; }
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

  return {
    uid: uid.trim(),
    summary: unescapeText(summary),
    description: singleProps["DESCRIPTION"] ? unescapeText(singleProps["DESCRIPTION"].value) : null,
    location: singleProps["LOCATION"] ? unescapeText(singleProps["LOCATION"].value) : null,
    startsAt: parseICalDateValue(dtstart.value, allDay),
    endsAt: parseICalDateValue(dtend.value, allDay),
    allDay,
    rrule: singleProps["RRULE"]?.value ?? null,
    createdAt: singleProps["CREATED"] ? parseICalDateValue(singleProps["CREATED"].value, false) : null,
    updatedAt: singleProps["LAST-MODIFIED"] ? parseICalDateValue(singleProps["LAST-MODIFIED"].value, false) : null,
    transp: singleProps["TRANSP"]?.value?.toUpperCase() ?? null,
    status: singleProps["STATUS"]?.value?.toUpperCase() ?? null,
    categories: categories && categories.length ? categories : null,
    organizer,
    attendees: attendees.length ? attendees : null,
    alarms: alarms.length ? alarms : null,
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

function parseICalDateValue(val: string, allDay: boolean): Date {
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
  // Z = UTC, missing Z = floating (treated as UTC for MVP — TODO: TZID support).
  return new Date(Date.UTC(y, mo, d, h, mi, s));
}
