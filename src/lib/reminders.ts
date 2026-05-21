import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { sendMail } from "./mailer.js";
import { env } from "../env.js";

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

function fmtTime(d: Date): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d);
  } catch { return d.toISOString(); }
}

function fmtRelative(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} 分钟`;
  if (m < 1440) return `${Math.round(m / 60)} 小时`;
  return `${Math.round(m / 1440)} 天`;
}

// Scan for events with VALARMs whose trigger time falls in [now-1min, now+1min]
// and dispatch reminder emails. Idempotent via reminders_sent unique-key.
export async function dispatchDueReminders(logger: { warn: (m: unknown) => void }): Promise<{ scanned: number; sent: number }> {
  const now = Date.now();
  // Look at events starting in the next 30 days (so a daily-reminder doesn't
  // miss). For each, parse alarms from extra.alarms, see if any trigger time
  // ≈ now (±60s), and send if not already in reminders_sent.
  const upcoming = await db
    .select({
      id: schema.events.id, summary: schema.events.summary, startsAt: schema.events.startsAt,
      endsAt: schema.events.endsAt, location: schema.events.location, extra: schema.events.extra,
      calendarId: schema.events.calendarId,
    })
    .from(schema.events)
    .where(and(
      gte(schema.events.startsAt, new Date(now)),
      lte(schema.events.startsAt, new Date(now + 30 * 24 * 60 * 60 * 1000)),
      isNull(schema.events.deletedAt),
    ));

  let sent = 0;
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  for (const ev of upcoming) {
    const extra = (ev.extra as { alarms?: { trigger: string; description?: string | null }[] } | null) ?? null;
    if (!extra || !Array.isArray(extra.alarms) || extra.alarms.length === 0) continue;
    for (const alarm of extra.alarms) {
      const offset = parseTriggerMs(alarm.trigger);
      if (offset === null) continue;
      const triggerAt = ev.startsAt.getTime() - offset;
      if (Math.abs(triggerAt - now) > 60_000) continue; // not in this minute's window
      // Already sent?
      const sentRow = await db.select().from(schema.remindersSent)
        .where(and(eq(schema.remindersSent.eventId, ev.id), eq(schema.remindersSent.trigger, alarm.trigger))).limit(1);
      if (sentRow.length > 0) continue;
      // Find the owner of this event's calendar = the user to remind.
      const [cal] = await db.select({ ownerId: schema.calendars.ownerId }).from(schema.calendars).where(eq(schema.calendars.id, ev.calendarId)).limit(1);
      if (!cal) continue;
      const [owner] = await db.select({ email: schema.users.email, displayName: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, cal.ownerId)).limit(1);
      if (!owner) continue;
      try {
        await sendMail({
          to: owner.email,
          subject: `⏰ ${fmtRelative(offset)}后：${ev.summary}`,
          text: `${ev.summary}\n开始：${fmtTime(ev.startsAt)}${ev.location ? `\n地点：${ev.location}` : ""}\n\n${baseUrl}/app`,
          html: `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:520px;margin:auto;padding:24px;background:#f1f5f9;">
            <div style="background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
              <div style="font-size:13px;color:#6366f1;font-weight:600;letter-spacing:1px;text-transform:uppercase;">提醒 · REMINDER</div>
              <h1 style="margin:8px 0 12px;font-size:22px;color:#0f172a;">${ev.summary.replace(/[<>&]/g, "")}</h1>
              <div style="font-size:14px;color:#475569;line-height:1.8;">
                ⏰ <strong>${fmtRelative(offset)}后</strong>开始<br/>
                📅 ${fmtTime(ev.startsAt)}${ev.location ? `<br/>📍 ${ev.location.replace(/[<>&]/g, "")}` : ""}
              </div>
              <p style="margin:16px 0 0;"><a href="${baseUrl}/app" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:13px;">打开日历</a></p>
            </div>
          </div>`,
        });
        await db.insert(schema.remindersSent).values({ eventId: ev.id, trigger: alarm.trigger });
        sent++;
      } catch (err) {
        logger.warn({ err, eventId: ev.id, trigger: alarm.trigger });
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
