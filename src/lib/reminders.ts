import { and, eq, gte, isNull, lte, or, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { sendMail } from "./mailer.js";
import { env } from "../env.js";
import { expandEvent } from "./rrule_expand.js";
import { pushToUser } from "./push.js";
import { getSettings } from "./site_settings.js";

// We support iCalendar TRIGGER values shaped like "-PT15M" / "-PT1H" / "-P1D"
// (negative relative durations) — the common case. Anything weirder is
// silently skipped. Returns milliseconds-before-start (positive number).
function parseTriggerMs(t: string): number | null {
  const m = t.trim().match(/^-?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i);
  if (!m) return null;
  const days = Number(m[1] || 0), hours = Number(m[2] || 0), minutes = Number(m[3] || 0);
  const total = ((days * 24 + hours) * 60 + minutes) * 60 * 1000;
  return total > 0 ? total : null;
}

// Format a Date in the event's stored timezone (falls back to Shanghai
// for legacy events that pre-date the timezone column). The label suffix
// — "(上海时间)" — only renders when the event TZ differs from the
// site's default so the reminder doesn't get cluttered for the common case.
// Reminder notifications go out in whatever language the recipient chose
// (users.locale, falling back to the site default). Dates + relative times use
// Intl so they read naturally per-locale; the few fixed labels come from here.
const REMINDER_STRINGS: Record<string, { starts: string; location: string; open: string; reminder: string }> = {
  "zh-CN": { starts: "开始", location: "地点", open: "打开日历", reminder: "提醒" },
  "zh-TW": { starts: "開始", location: "地點", open: "開啟日曆", reminder: "提醒" },
  "en": { starts: "Starts", location: "Location", open: "Open calendar", reminder: "Reminder" },
  "ja": { starts: "開始", location: "場所", open: "カレンダーを開く", reminder: "リマインダー" },
  "ko": { starts: "시작", location: "위치", open: "캘린더 열기", reminder: "알림" },
  "es": { starts: "Comienza", location: "Lugar", open: "Abrir calendario", reminder: "Recordatorio" },
  "fr": { starts: "Début", location: "Lieu", open: "Ouvrir le calendrier", reminder: "Rappel" },
  "de": { starts: "Beginn", location: "Ort", open: "Kalender öffnen", reminder: "Erinnerung" },
};
function reminderStrings(locale: string) {
  return REMINDER_STRINGS[locale] ?? REMINDER_STRINGS.en!;
}

function fmtTime(locale: string, d: Date, tz?: string | null): string {
  const targetTz = tz || "Asia/Shanghai";
  try {
    const base = new Intl.DateTimeFormat(locale, {
      timeZone: targetTz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d);
    return tz && tz !== "Asia/Shanghai" ? `${base} (${targetTz})` : base;
  } catch { return d.toISOString(); }
}

// "in 30 minutes" / "30分钟后" / "dans 30 minutes" — Intl picks the phrasing.
function fmtRelative(locale: string, ms: number): string {
  const m = Math.round(ms / 60_000);
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "long" });
    if (m < 60) return rtf.format(m, "minute");
    if (m < 1440) return rtf.format(Math.round(m / 60), "hour");
    return rtf.format(Math.round(m / 1440), "day");
  } catch {
    if (m < 60) return `${m} 分钟后`;
    if (m < 1440) return `${Math.round(m / 60)} 小时后`;
    return `${Math.round(m / 1440)} 天后`;
  }
}

// Scan for events with VALARMs whose trigger time falls in [now-1min, now+1min]
// and dispatch reminder emails. Idempotent via reminders_sent unique-key
// on (event_id, trigger, instance_start) — so each occurrence of a
// recurring event gets reminded independently.
export async function dispatchDueReminders(logger: { warn: (m: unknown) => void }): Promise<{ scanned: number; sent: number }> {
  const now = Date.now();
  // Pull non-recurring events starting in the next 30 days, PLUS every
  // recurring event regardless of master startsAt (since their occurrences
  // could fall in our window even if the master DTSTART is months in the
  // past). The expandEvent helper bounds CPU work per event.
  const upcoming = await db
    .select({
      id: schema.events.id, summary: schema.events.summary, startsAt: schema.events.startsAt,
      endsAt: schema.events.endsAt, location: schema.events.location, extra: schema.events.extra,
      calendarId: schema.events.calendarId, rrule: schema.events.rrule,
      exdates: schema.events.exdates,
    })
    .from(schema.events)
    .where(and(
      or(
        // Non-recurring: master starts in the next 30 days
        and(isNull(schema.events.rrule), gte(schema.events.startsAt, new Date(now - 60_000)), lte(schema.events.startsAt, new Date(now + 30 * 24 * 60 * 60 * 1000))),
        // Recurring: any master, expansion does the time filtering
        isNotNull(schema.events.rrule),
      ),
      isNull(schema.events.deletedAt),
    ));

  let sent = 0;
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const siteDefaultLocale = (await getSettings()).defaultLocale || "zh-CN";
  const expansionWindowEnd = new Date(now + 30 * 24 * 60 * 60 * 1000);
  for (const ev of upcoming) {
    const extra = (ev.extra as { alarms?: { trigger: string; description?: string | null }[] } | null) ?? null;
    if (!extra || !Array.isArray(extra.alarms) || extra.alarms.length === 0) continue;
    // Expand to per-occurrence instances. For non-recurring this yields
    // a single instance (or none if outside the window).
    const occurrences = expandEvent(
      {
        id: ev.id,
        startsAt: ev.startsAt,
        endsAt: ev.endsAt,
        rrule: ev.rrule ?? null,
        exdates: (ev.exdates as string[] | null) ?? null,
      },
      new Date(now - 60_000),  // small backward window so trigger-now alarms still fire
      expansionWindowEnd,
    );
    for (const occ of occurrences) {
      for (const alarm of extra.alarms) {
        const offset = parseTriggerMs(alarm.trigger);
        if (offset === null) continue;
        const triggerAt = occ.startsAt.getTime() - offset;
        if (Math.abs(triggerAt - now) > 60_000) continue; // not in this minute's window
        // Already sent for this (event, trigger, instance)?
        const sentRow = await db.select().from(schema.remindersSent)
          .where(and(
            eq(schema.remindersSent.eventId, ev.id),
            eq(schema.remindersSent.trigger, alarm.trigger),
            eq(schema.remindersSent.instanceStart, occ.startsAt),
          )).limit(1);
        if (sentRow.length > 0) continue;
        // Find the owner of this event's calendar = the user to remind.
        const [cal] = await db.select({ ownerId: schema.calendars.ownerId }).from(schema.calendars).where(eq(schema.calendars.id, ev.calendarId)).limit(1);
        if (!cal) continue;
        const [owner] = await db.select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName, disabledAt: schema.users.disabledAt, locale: schema.users.locale }).from(schema.users).where(eq(schema.users.id, cal.ownerId)).limit(1);
        if (!owner || owner.disabledAt) continue;  // don't email disabled users
        // Fire a web-push notification in parallel with the email. If the
        // user has no push subscriptions registered, pushToUser is a no-op.
        // Tag includes the trigger so identical reminders on different
        // events still surface separately, but the same alarm firing twice
        // (shouldn't happen due to remindersSent unique key) collapses.
        // Pull the event's stored timezone from extra so reminder
        // formatting matches what the organizer originally chose.
        const eventTz = (ev.extra as { timezone?: string } | null)?.timezone ?? null;
        // Localize to the recipient's chosen language (or the site default).
        const loc = owner.locale || siteDefaultLocale;
        const S = reminderStrings(loc);
        const rel = fmtRelative(loc, offset); // "in 30 minutes" / "30分钟后"
        const when = fmtTime(loc, occ.startsAt, eventTz);
        void pushToUser(owner.id, {
          title: `⏰ ${ev.summary}`,
          body: `${rel} · ${when}${ev.location ? " · " + ev.location : ""}`,
          url: "/app",
          tag: `event-${ev.id}-${alarm.trigger}`,
        }).catch(() => undefined);
        try {
          await sendMail({
            to: owner.email,
            subject: `⏰ ${ev.summary} · ${rel}`,
            text: `${ev.summary}\n${rel}\n${S.starts}: ${when}${ev.location ? `\n${S.location}: ${ev.location}` : ""}\n\n${baseUrl}/app`,
            html: `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:520px;margin:auto;padding:24px;background:#f1f5f9;">
              <div style="background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
                <div style="font-size:13px;color:#6366f1;font-weight:600;letter-spacing:1px;text-transform:uppercase;">${S.reminder}</div>
                <h1 style="margin:8px 0 12px;font-size:22px;color:#0f172a;">${ev.summary.replace(/[<>&]/g, "")}</h1>
                <div style="font-size:14px;color:#475569;line-height:1.8;">
                  ⏰ <strong>${rel}</strong><br/>
                  📅 ${when}${ev.location ? `<br/>📍 ${ev.location.replace(/[<>&]/g, "")}` : ""}
                </div>
                <p style="margin:16px 0 0;"><a href="${baseUrl}/app" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:13px;">${S.open}</a></p>
              </div>
            </div>`,
          });
          await db.insert(schema.remindersSent).values({ eventId: ev.id, trigger: alarm.trigger, instanceStart: occ.startsAt });
          sent++;
        } catch (err) {
          logger.warn({ err, eventId: ev.id, trigger: alarm.trigger, instance: occ.startsAt.toISOString() });
        }
      }
    }
  }
  return { scanned: upcoming.length, sent };
}

let started = false;
export function startReminderScheduler(log: { info: (m: string) => void; warn: (m: unknown) => void }): void {
  if (started) return;
  started = true;
  // Run every minute. The DB unique-key on reminders_sent gives us correctness
  // even across overlapping runs / multi-replica deployments.
  const tick = async () => {
    try {
      const result = await dispatchDueReminders(log);
      if (result.sent > 0) log.info(`[reminders] sent ${result.sent} of ${result.scanned} upcoming`);
    } catch (err) {
      log.warn({ err });
    }
  };
  setTimeout(() => { void tick(); }, 45_000);
  setInterval(() => { void tick(); }, 60_000);
  log.info("reminder scheduler started (1-min tick)");
}
