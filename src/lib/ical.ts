// Minimal iCalendar (RFC 5545) parser and serializer for CalDAV.
// Handles the subset of properties our calendar app supports: UID, SUMMARY,
// DESCRIPTION, LOCATION, DTSTART/DTEND (date + datetime, UTC + floating),
// CREATED, LAST-MODIFIED, DTSTAMP, RRULE.

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
};

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

export function parseEvent(ics: string): IcalEvent | null {
  // Unfold continuation lines (CRLF + space or tab).
  const unfolded = ics.replace(/\r?\n[\t ]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const start = lines.findIndex((l) => l.toUpperCase() === "BEGIN:VEVENT");
  const end = lines.findIndex((l) => l.toUpperCase() === "END:VEVENT");
  if (start < 0 || end < 0 || end <= start) return null;

  const props: Record<string, { params: Record<string, string>; value: string }> = {};
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const head = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    const segments = head.split(";");
    const name = segments[0] ?? "";
    if (!name) continue;
    const paramParts = segments.slice(1);
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    }
    props[name.toUpperCase()] = { params, value };
  }

  const uid = props["UID"]?.value;
  const summary = props["SUMMARY"]?.value;
  const dtstart = props["DTSTART"];
  const dtend = props["DTEND"];
  if (!uid || !summary || !dtstart || !dtend) return null;

  const allDay = dtstart.params["VALUE"] === "DATE";

  return {
    uid: uid.trim(),
    summary: unescapeText(summary),
    description: props["DESCRIPTION"] ? unescapeText(props["DESCRIPTION"].value) : null,
    location: props["LOCATION"] ? unescapeText(props["LOCATION"].value) : null,
    startsAt: parseICalDateValue(dtstart.value, allDay),
    endsAt: parseICalDateValue(dtend.value, allDay),
    allDay,
    rrule: props["RRULE"]?.value ?? null,
    createdAt: props["CREATED"] ? parseICalDateValue(props["CREATED"].value, false) : null,
    updatedAt: props["LAST-MODIFIED"] ? parseICalDateValue(props["LAST-MODIFIED"].value, false) : null,
  };
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
