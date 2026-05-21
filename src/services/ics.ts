import ical, { ICalCalendarMethod } from "ical-generator";
import type { Calendar, Event } from "../db/schema.js";
import { env } from "../env.js";

export function buildIcsFeed(calendar: Calendar, events: Event[]): string {
  const cal = ical({
    name: calendar.name,
    description: calendar.description ?? undefined,
    timezone: calendar.timezone,
    prodId: { company: "by-wave.cn", product: "by-wave-calendar" },
    method: ICalCalendarMethod.PUBLISH,
    url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/cal/${calendar.id}`,
  });

  for (const ev of events) {
    cal.createEvent({
      id: ev.uid,
      start: ev.startsAt,
      end: ev.endsAt,
      allDay: ev.allDay,
      summary: ev.summary,
      description: ev.description ?? undefined,
      location: ev.location ?? undefined,
      repeating: ev.rrule ? ev.rrule : undefined,
      created: ev.createdAt,
      lastModified: ev.updatedAt,
    });
  }

  return cal.toString();
}
