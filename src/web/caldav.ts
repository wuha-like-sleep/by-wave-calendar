import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { basicAuth } from "../lib/caldav_auth.js";
import { extractVeventBlock, invitationIcs, parseEvent, serializeEvent, wrapSingleEvent, type IcalEvent } from "../lib/ical.js";
import { newInvitationToken } from "../lib/ids.js";
import { sendMail } from "../lib/mailer.js";
import { eventInviteMail } from "../lib/email_templates.js";

// ---------- XML helpers ----------

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function etagOf(t: Date | string): string {
  const v = typeof t === "string" ? t : t.toISOString();
  return `"${crypto.createHash("md5").update(v).digest("hex")}"`;
}

function calendarCtag(updates: Date[]): string {
  if (updates.length === 0) return etagOf("empty");
  const latest = updates.reduce((acc, d) => (d > acc ? d : acc), new Date(0));
  return etagOf(latest);
}

const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';
const NS = `xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:IC="http://apple.com/ns/ical/"`;

// ---------- Multistatus builders ----------

type PropDict = {
  resourcetype?: string;            // raw inner XML
  displayname?: string;
  currentUserPrincipal?: string;    // href
  calendarHomeSet?: string;         // href
  calendarUserAddressSet?: string;  // mailto:
  supportedCalendarComponentSet?: string[];  // ["VEVENT"]
  supportedReportSet?: boolean;
  ctag?: string;
  etag?: string;
  contentType?: string;             // getcontenttype — required by iOS for resources
  contentLength?: number;
  lastModified?: Date;
  calendarData?: string;            // iCalendar text
  ownerHref?: string;
  calendarColor?: string;
  calendarDescription?: string;
  calendarTimezone?: string;
  currentUserPrivilegeSet?: boolean;
};

function buildPropXml(props: PropDict): string {
  const parts: string[] = [];
  if (props.resourcetype !== undefined) parts.push(`<resourcetype>${props.resourcetype}</resourcetype>`);
  if (props.displayname !== undefined) parts.push(`<displayname>${xmlEscape(props.displayname)}</displayname>`);
  if (props.currentUserPrincipal !== undefined) parts.push(`<current-user-principal><href>${xmlEscape(props.currentUserPrincipal)}</href></current-user-principal>`);
  if (props.calendarHomeSet !== undefined) parts.push(`<C:calendar-home-set><href>${xmlEscape(props.calendarHomeSet)}</href></C:calendar-home-set>`);
  if (props.calendarUserAddressSet !== undefined) parts.push(`<C:calendar-user-address-set><href>${xmlEscape(props.calendarUserAddressSet)}</href></C:calendar-user-address-set>`);
  if (props.supportedCalendarComponentSet !== undefined) {
    const comps = props.supportedCalendarComponentSet.map(c => `<C:comp name="${xmlEscape(c)}"/>`).join("");
    parts.push(`<C:supported-calendar-component-set>${comps}</C:supported-calendar-component-set>`);
  }
  if (props.supportedReportSet) {
    parts.push(`<supported-report-set>
      <supported-report><report><C:calendar-query/></report></supported-report>
      <supported-report><report><C:calendar-multiget/></report></supported-report>
    </supported-report-set>`);
  }
  if (props.ctag !== undefined) parts.push(`<CS:getctag>${xmlEscape(props.ctag)}</CS:getctag>`);
  if (props.etag !== undefined) parts.push(`<getetag>${xmlEscape(props.etag)}</getetag>`);
  if (props.contentType !== undefined) parts.push(`<getcontenttype>${xmlEscape(props.contentType)}</getcontenttype>`);
  if (props.contentLength !== undefined) parts.push(`<getcontentlength>${props.contentLength}</getcontentlength>`);
  if (props.lastModified !== undefined) parts.push(`<getlastmodified>${xmlEscape(props.lastModified.toUTCString())}</getlastmodified>`);
  if (props.calendarData !== undefined) parts.push(`<C:calendar-data>${xmlEscape(props.calendarData)}</C:calendar-data>`);
  if (props.ownerHref !== undefined) parts.push(`<owner><href>${xmlEscape(props.ownerHref)}</href></owner>`);
  if (props.calendarColor !== undefined) parts.push(`<IC:calendar-color>${xmlEscape(props.calendarColor)}</IC:calendar-color>`);
  if (props.calendarDescription !== undefined) parts.push(`<C:calendar-description>${xmlEscape(props.calendarDescription)}</C:calendar-description>`);
  if (props.calendarTimezone !== undefined) parts.push(`<C:calendar-timezone>${xmlEscape(props.calendarTimezone)}</C:calendar-timezone>`);
  if (props.currentUserPrivilegeSet) {
    parts.push(`<current-user-privilege-set>
      <privilege><read/></privilege>
      <privilege><write/></privilege>
      <privilege><write-properties/></privilege>
      <privilege><write-content/></privilege>
      <privilege><bind/></privilege>
      <privilege><unbind/></privilege>
    </current-user-privilege-set>`);
  }
  return parts.join("");
}

function responseEntry(href: string, props: PropDict, status = "HTTP/1.1 200 OK"): string {
  return `<response>
    <href>${xmlEscape(href)}</href>
    <propstat>
      <prop>${buildPropXml(props)}</prop>
      <status>${status}</status>
    </propstat>
  </response>`;
}

function multistatus(entries: string[]): string {
  return `${XML_DECL}\n<multistatus ${NS}>\n${entries.join("\n")}\n</multistatus>`;
}

// ---------- Path helpers ----------

function principalHref(userId: string): string { return `/caldav/principals/${userId}/`; }
function homeHref(userId: string): string { return `/caldav/${userId}/`; }
function calendarHref(userId: string, calId: string): string { return `/caldav/${userId}/${calId}/`; }
function eventHref(userId: string, calId: string, uid: string): string { return `/caldav/${userId}/${calId}/${uid}.ics`; }

// ---------- Common helpers ----------

function sendXml(reply: FastifyReply, body: string, code = 207): void {
  reply
    .code(code)
    .header("Content-Type", 'application/xml; charset="utf-8"')
    .header("DAV", "1, 2, 3, calendar-access")
    .send(body);
}

function setOptionsHeaders(reply: FastifyReply): void {
  reply
    .header("DAV", "1, 2, 3, calendar-access")
    .header("Allow", "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT")
    .header("Accept-Ranges", "bytes");
}

function depthHeader(req: FastifyRequest): "0" | "1" | "infinity" {
  const h = String(req.headers["depth"] ?? "0").toLowerCase();
  if (h === "1") return "1";
  if (h === "infinity") return "infinity";
  return "0";
}

async function loadCalendarOwned(userId: string, calId: string) {
  const [cal] = await db
    .select()
    .from(schema.calendars)
    .where(and(eq(schema.calendars.id, calId), eq(schema.calendars.ownerId, userId)))
    .limit(1);
  return cal ?? null;
}

async function loadAllEventsOf(calId: string) {
  return db.select().from(schema.events).where(eq(schema.events.calendarId, calId)).orderBy(asc(schema.events.startsAt));
}

function rowToIcal(row: schema.Event): IcalEvent {
  return {
    uid: row.uid,
    summary: row.summary,
    description: row.description,
    location: row.location,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    allDay: row.allDay,
    rrule: row.rrule,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Wrap an event's iCalendar body for outbound delivery. Prefers the raw VEVENT
// the client originally sent (preserves ATTENDEE / VALARM / TRANSP / CATEGORIES /
// X-*); falls back to synthesizing one from the parsed columns for events created
// via the web UI (or imported) where no raw body was ever stored.
function rowToVCalendar(row: schema.Event, calName: string): string {
  if (row.rawIcs && row.rawIcs.includes("BEGIN:VEVENT")) {
    const CRLF = "\r\n";
    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//ByWave-Calendar//CalDAV//EN",
      "CALSCALE:GREGORIAN",
      `X-WR-CALNAME:${calName.replace(/[\r\n]/g, " ")}`,
      row.rawIcs,
      "END:VCALENDAR",
    ].join(CRLF) + CRLF;
  }
  return wrapSingleEvent(rowToIcal(row), calName);
}

// ---------- Route handlers ----------

async function handleOptions(_req: FastifyRequest, reply: FastifyReply) {
  setOptionsHeaders(reply);
  reply.code(200).send();
}

// PROPFIND / (root) — return current-user-principal pointing to user's principal
async function propfindRoot(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return;
  const body = multistatus([
    responseEntry("/caldav/", {
      resourcetype: "<collection/>",
      displayname: "ByWave Calendars",
      currentUserPrincipal: principalHref(user.id),
    }),
  ]);
  sendXml(reply, body);
}

// PROPFIND /caldav/principals/<userId>/
async function propfindPrincipal(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return;
  const params = req.params as { userId?: string };
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");

  const body = multistatus([
    responseEntry(principalHref(user.id), {
      resourcetype: "<collection/><principal/>",
      displayname: user.displayName ?? user.email,
      currentUserPrincipal: principalHref(user.id),
      calendarHomeSet: homeHref(user.id),
      calendarUserAddressSet: `mailto:${user.email}`,
    }),
  ]);
  sendXml(reply, body);
}

// PROPFIND /caldav/<userId>/ — calendar-home: lists user's calendars (Depth 1)
async function propfindHome(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return;
  const params = req.params as { userId?: string };
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");

  const depth = depthHeader(req);
  const entries: string[] = [];

  entries.push(responseEntry(homeHref(user.id), {
    resourcetype: "<collection/>",
    displayname: "我的日历",
    currentUserPrincipal: principalHref(user.id),
    ownerHref: principalHref(user.id),
  }));

  if (depth !== "0") {
    const cals = await db.select().from(schema.calendars).where(eq(schema.calendars.ownerId, user.id));
    for (const c of cals) {
      const events = await loadAllEventsOf(c.id);
      entries.push(responseEntry(calendarHref(user.id, c.id), {
        resourcetype: '<collection/><C:calendar/>',
        displayname: c.name,
        supportedCalendarComponentSet: ["VEVENT"],
        supportedReportSet: true,
        ctag: calendarCtag(events.map(e => e.updatedAt)),
        ownerHref: principalHref(user.id),
        calendarColor: c.color,
        calendarDescription: c.description ?? undefined,
        calendarTimezone: c.timezone,
        currentUserPrivilegeSet: true,
      }));
    }
  }
  sendXml(reply, multistatus(entries));
}

// PROPFIND /caldav/<userId>/<calId>/ — single calendar, optionally with events
async function propfindCalendar(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return;
  const params = req.params as { userId?: string; calId?: string };
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");
  const cal = await loadCalendarOwned(user.id, params.calId ?? "");
  if (!cal) return reply.code(404).send("Not Found");

  const depth = depthHeader(req);
  const events = await loadAllEventsOf(cal.id);
  const entries: string[] = [];

  entries.push(responseEntry(calendarHref(user.id, cal.id), {
    resourcetype: '<collection/><C:calendar/>',
    displayname: cal.name,
    supportedCalendarComponentSet: ["VEVENT"],
    supportedReportSet: true,
    ctag: calendarCtag(events.map(e => e.updatedAt)),
    ownerHref: principalHref(user.id),
    calendarColor: cal.color,
    calendarDescription: cal.description ?? undefined,
    calendarTimezone: cal.timezone,
    currentUserPrivilegeSet: true,
  }));

  if (depth !== "0") {
    for (const e of events) {
      entries.push(responseEntry(eventHref(user.id, cal.id, e.uid), {
        resourcetype: "",
        etag: etagOf(e.updatedAt),
        contentType: "text/calendar; charset=utf-8; component=VEVENT",
        lastModified: e.updatedAt,
      }));
    }
  }
  sendXml(reply, multistatus(entries));
}

// REPORT /caldav/<userId>/<calId>/ — calendar-query / calendar-multiget
async function reportCalendar(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return;
  const params = req.params as { userId?: string; calId?: string };
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");
  const cal = await loadCalendarOwned(user.id, params.calId ?? "");
  if (!cal) return reply.code(404).send("Not Found");

  const bodyStr = String(req.body ?? "");

  // calendar-multiget: client lists explicit hrefs
  if (/<C:calendar-multiget[\s>]/i.test(bodyStr) || /calendar-multiget/i.test(bodyStr)) {
    // Extract <href>...</href> entries from the request body
    const hrefMatches = Array.from(bodyStr.matchAll(/<(?:[A-Za-z0-9]+:)?href[^>]*>([^<]+)<\/(?:[A-Za-z0-9]+:)?href>/g));
    const wantedUids = hrefMatches.map(m => {
      const href = (m[1] ?? "").trim();
      const match = href.match(/\/([^/]+)\.ics$/);
      return match?.[1] ?? null;
    }).filter((x): x is string => !!x);

    const events = wantedUids.length === 0
      ? await loadAllEventsOf(cal.id)
      : (await db
          .select()
          .from(schema.events)
          .where(and(eq(schema.events.calendarId, cal.id))))
          .filter(e => wantedUids.includes(e.uid));

    const entries = events.map(e => responseEntry(eventHref(user.id, cal.id, e.uid), {
      etag: etagOf(e.updatedAt),
      contentType: "text/calendar; charset=utf-8; component=VEVENT",
      lastModified: e.updatedAt,
      calendarData: rowToVCalendar(e, cal.name),
    }));
    sendXml(reply, multistatus(entries));
    return;
  }

  // calendar-query: optional time-range filter
  let start: Date | null = null;
  let end: Date | null = null;
  const trMatch = bodyStr.match(/<(?:[A-Za-z0-9]+:)?time-range\s+([^/>]+)\/?\s*>/i);
  if (trMatch) {
    const attrs = trMatch[1] ?? "";
    const s = attrs.match(/start="([^"]+)"/i)?.[1];
    const e = attrs.match(/end="([^"]+)"/i)?.[1];
    if (s) start = parseIcalUtcStamp(s);
    if (e) end = parseIcalUtcStamp(e);
  }

  let events = await loadAllEventsOf(cal.id);
  if (start || end) {
    events = events.filter(ev => {
      if (start && ev.endsAt < start) return false;
      if (end && ev.startsAt > end) return false;
      return true;
    });
  }

  const entries = events.map(e => responseEntry(eventHref(user.id, cal.id, e.uid), {
    etag: etagOf(e.updatedAt),
    calendarData: rowToVCalendar(e, cal.name),
  }));
  sendXml(reply, multistatus(entries));
}

function parseIcalUtcStamp(val: string): Date | null {
  // Accept "20260522T100000Z" or "20260522T100000"
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return null;
  return new Date(Date.UTC(+(m[1] ?? "0"), +(m[2] ?? "1") - 1, +(m[3] ?? "1"), +(m[4] ?? "0"), +(m[5] ?? "0"), +(m[6] ?? "0")));
}

// GET /caldav/<userId>/<calId>/<uid>.ics — single event as iCalendar
async function getEvent(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return;
  const params = req.params as { userId?: string; calId?: string; uid?: string };
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");
  const cal = await loadCalendarOwned(user.id, params.calId ?? "");
  if (!cal) return reply.code(404).send("Not Found");

  const [event] = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.calendarId, cal.id), eq(schema.events.uid, params.uid ?? "")))
    .limit(1);
  if (!event) return reply.code(404).send("Not Found");

  reply
    .header("Content-Type", "text/calendar; charset=utf-8")
    .header("ETag", etagOf(event.updatedAt));
  return reply.send(rowToVCalendar(event, cal.name));
}

// PUT /caldav/<userId>/<calId>/<uid>.ics — create or update
async function putEvent(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return;
  const params = req.params as { userId?: string; calId?: string; uid?: string };
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");
  const cal = await loadCalendarOwned(user.id, params.calId ?? "");
  if (!cal) return reply.code(404).send("Not Found");

  const bodyStr = typeof req.body === "string" ? req.body : "";
  req.log.info({
    caldav: "put",
    userId: user.id, calId: params.calId, uid: params.uid,
    contentType: req.headers["content-type"],
    bodyBytes: bodyStr.length,
    bodyHead: bodyStr.slice(0, 200),
    ifMatch: req.headers["if-match"], ifNoneMatch: req.headers["if-none-match"],
  }, "caldav_put");
  const parsed = parseEvent(bodyStr);
  if (!parsed) {
    req.log.warn({ caldav: "put", bodyHead: bodyStr.slice(0, 400) }, "caldav_put_parse_failed");
    return reply.code(400).send("Invalid iCalendar");
  }
  const rawVevent = extractVeventBlock(bodyStr);

  // The UID in the URL might differ from the UID in the body — use body UID as authoritative,
  // but match against URL for existing lookup.
  const urlUid = params.uid ?? parsed.uid;

  const [existing] = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.calendarId, cal.id), eq(schema.events.uid, urlUid)))
    .limit(1);

  // Anything the client sent that we can't fold into structured columns (TRANSP,
  // ATTENDEE list, VALARM reminders, CATEGORIES, ORGANIZER, custom X-*) is preserved
  // by storing the raw VEVENT block; GET/REPORT prefers raw_ics so the round-trip
  // is lossless and the phone doesn't see "the server stripped my event" and delete.
  const extraPatch: Record<string, unknown> = { ...((existing?.extra as Record<string, unknown> | null) ?? {}) };
  if (parsed.transp) extraPatch.transp = parsed.transp;
  if (parsed.status) extraPatch.status = parsed.status;
  if (parsed.attendees) extraPatch.attendees = parsed.attendees;
  if (parsed.alarms) extraPatch.alarms = parsed.alarms;
  if (parsed.organizer) extraPatch.organizer = parsed.organizer;
  if (parsed.categories) extraPatch.categories = parsed.categories;

  let stored: schema.Event;
  if (existing) {
    const ifMatch = req.headers["if-match"];
    if (ifMatch && ifMatch !== "*" && ifMatch !== etagOf(existing.updatedAt)) {
      return reply.code(412).send("Precondition Failed");
    }
    const [updated] = await db
      .update(schema.events)
      .set({
        summary: parsed.summary,
        description: parsed.description ?? null,
        location: parsed.location ?? null,
        startsAt: parsed.startsAt,
        endsAt: parsed.endsAt,
        allDay: parsed.allDay,
        rrule: parsed.rrule ?? null,
        extra: Object.keys(extraPatch).length ? extraPatch : null,
        rawIcs: rawVevent,
        updatedAt: new Date(),
      })
      .where(eq(schema.events.id, existing.id))
      .returning();
    stored = updated!;
  } else {
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch === "*" && existing) {
      return reply.code(412).send("Precondition Failed");
    }
    const [inserted] = await db
      .insert(schema.events)
      .values({
        calendarId: cal.id,
        uid: urlUid,
        summary: parsed.summary,
        description: parsed.description ?? null,
        location: parsed.location ?? null,
        startsAt: parsed.startsAt,
        endsAt: parsed.endsAt,
        allDay: parsed.allDay,
        rrule: parsed.rrule ?? null,
        extra: Object.keys(extraPatch).length ? extraPatch : null,
        rawIcs: rawVevent,
      })
      .returning();
    stored = inserted!;
  }

  // If this is a brand-new event that has ATTENDEEs other than the organizer
  // themselves, mirror what /api/events does — send each attendee an "Add to
  // your calendar" email with a METHOD:REQUEST .ics attachment. iOS / Apple
  // Calendar PUTs go through this path too, so an event you add on the phone
  // also gets the invite emails fired.
  if (!existing && parsed.attendees && parsed.attendees.length > 0) {
    const recipientList = parsed.attendees
      .map((a) => (a.email || "").toLowerCase().trim())
      .filter((e) => e && e.includes("@") && e !== user.email.toLowerCase());
    if (recipientList.length > 0) {
      const organizerName = user.displayName || user.email;
      const ics = invitationIcs({
        event: {
          uid: stored.uid,
          summary: stored.summary,
          description: stored.description,
          location: stored.location,
          startsAt: stored.startsAt,
          endsAt: stored.endsAt,
          allDay: stored.allDay,
          updatedAt: stored.updatedAt,
        },
        organizerEmail: user.email,
        organizerName,
        attendees: recipientList.map((email) => ({ email })),
        method: "REQUEST",
      });
      const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
      for (const to of recipientList) {
        const inviteToken = newInvitationToken();
        try {
          await db.insert(schema.eventInviteTokens).values({
            token: inviteToken,
            sourceEventId: stored.id,
            recipientEmail: to,
            expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          });
        } catch (err) {
          req.log.warn({ err, to }, "caldav_invite_token_failed");
        }
        sendMail(eventInviteMail(to, {
          organizerEmail: user.email,
          organizerName,
          summary: stored.summary,
          description: stored.description,
          location: stored.location,
          startsAt: stored.startsAt,
          endsAt: stored.endsAt,
          allDay: stored.allDay,
          uid: stored.uid,
          icsBody: ics,
          inviteToken,
        })).catch((err) => req.log.warn({ err, to }, "caldav_invite_mail_failed"));
      }
      req.log.info({ caldav: "put_invites_sent", count: recipientList.length, eventId: stored.id }, "caldav_put_invites");
    }
  }

  reply.header("ETag", etagOf(stored.updatedAt));
  if (!existing) reply.header("Location", eventHref(user.id, cal.id, stored.uid));
  return reply.code(existing ? 204 : 201).send();
}

// DELETE /caldav/<userId>/<calId>/<uid>.ics
async function deleteEvent(req: FastifyRequest, reply: FastifyReply) {
  const user = await basicAuth(req, reply);
  if (!user) return;
  const params = req.params as { userId?: string; calId?: string; uid?: string };
  req.log.info({ caldav: "delete", userId: user.id, calId: params.calId, uid: params.uid, ifMatch: req.headers["if-match"] }, "caldav_delete");
  if (params.userId !== user.id) return reply.code(403).send("Forbidden");
  const cal = await loadCalendarOwned(user.id, params.calId ?? "");
  if (!cal) return reply.code(404).send("Not Found");

  const [event] = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.calendarId, cal.id), eq(schema.events.uid, params.uid ?? "")))
    .limit(1);
  if (!event) return reply.code(404).send("Not Found");

  const ifMatch = req.headers["if-match"];
  if (ifMatch && ifMatch !== "*" && ifMatch !== etagOf(event.updatedAt)) {
    return reply.code(412).send("Precondition Failed");
  }

  await db.delete(schema.events).where(eq(schema.events.id, event.id));
  return reply.code(204).send();
}

// ---------- Plugin ----------

export async function caldavRoutes(app: FastifyInstance) {
  // .well-known/caldav → redirect to /caldav/
  app.all("/.well-known/caldav", { config: { rateLimit: false } }, async (_req, reply) => {
    reply.code(301).header("Location", "/caldav/").send();
  });

  const allowedMethods = ["OPTIONS", "PROPFIND"] as const;

  // Root
  app.route({
    method: "OPTIONS",
    url: "/caldav",
    config: { rateLimit: false },
    handler: handleOptions,
  });
  app.route({
    method: "OPTIONS",
    url: "/caldav/",
    config: { rateLimit: false },
    handler: handleOptions,
  });
  app.route({
    method: "PROPFIND" as never,
    url: "/caldav/",
    config: { rateLimit: false },
    handler: propfindRoot,
  });
  app.route({
    method: "PROPFIND" as never,
    url: "/caldav",
    config: { rateLimit: false },
    handler: propfindRoot,
  });

  // Principal
  app.route({
    method: "OPTIONS",
    url: "/caldav/principals/:userId/",
    config: { rateLimit: false },
    handler: handleOptions,
  });
  app.route({
    method: "PROPFIND" as never,
    url: "/caldav/principals/:userId/",
    config: { rateLimit: false },
    handler: propfindPrincipal,
  });

  // Calendar home
  app.route({
    method: "OPTIONS",
    url: "/caldav/:userId/",
    config: { rateLimit: false },
    handler: handleOptions,
  });
  app.route({
    method: "PROPFIND" as never,
    url: "/caldav/:userId/",
    config: { rateLimit: false },
    handler: propfindHome,
  });

  // Single calendar
  app.route({
    method: "OPTIONS",
    url: "/caldav/:userId/:calId/",
    config: { rateLimit: false },
    handler: handleOptions,
  });
  app.route({
    method: "PROPFIND" as never,
    url: "/caldav/:userId/:calId/",
    config: { rateLimit: false },
    handler: propfindCalendar,
  });
  app.route({
    method: "REPORT" as never,
    url: "/caldav/:userId/:calId/",
    config: { rateLimit: false },
    handler: reportCalendar,
  });

  // Event resource
  app.route({
    method: "OPTIONS",
    url: "/caldav/:userId/:calId/:uid",
    config: { rateLimit: false },
    handler: handleOptions,
  });
  app.route({
    method: "GET",
    url: "/caldav/:userId/:calId/:uid",
    config: { rateLimit: false },
    handler: (req, reply) => {
      // Strip .ics suffix
      const p = req.params as { uid?: string };
      if (p.uid) p.uid = p.uid.replace(/\.ics$/i, "");
      return getEvent(req, reply);
    },
  });
  app.route({
    method: "PUT",
    url: "/caldav/:userId/:calId/:uid",
    config: { rateLimit: false },
    handler: (req, reply) => {
      const p = req.params as { uid?: string };
      if (p.uid) p.uid = p.uid.replace(/\.ics$/i, "");
      return putEvent(req, reply);
    },
  });
  app.route({
    method: "DELETE",
    url: "/caldav/:userId/:calId/:uid",
    config: { rateLimit: false },
    handler: (req, reply) => {
      const p = req.params as { uid?: string };
      if (p.uid) p.uid = p.uid.replace(/\.ics$/i, "");
      return deleteEvent(req, reply);
    },
  });

  void allowedMethods;
}
