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
