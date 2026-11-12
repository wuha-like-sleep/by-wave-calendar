import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { expansionTimeZone, rawIcsStartIsUtc } from "../event_zone.js";
import { seriesStartsBetween, exdateMillis } from "../rrule_expand.js";
import { notifyEventCancellation } from "../event_cancel.js";
import { contentSchema, SyncConflictError, SyncUnavailableError, localOrigin, type SyncContent, type SyncItem } from "./model.js";
import type { SyncSide } from "./engine.js";

type Extra = Record<string, unknown>;
const extraOf = (row: schema.Event): Extra => row.extra && typeof row.extra === "object" && !Array.isArray(row.extra) ? row.extra as Extra : {};
export class ByWaveCalendar implements SyncSide {
  constructor(private readonly userId: string, private readonly calendarId: string, private readonly pairId: string, private readonly from: Date, private readonly to: Date) {}
  private async calendar() {
    const [cal] = await db.select().from(schema.calendars).where(and(eq(schema.calendars.id, this.calendarId), eq(schema.calendars.ownerId, this.userId)));
    if (!cal) throw new SyncUnavailableError("calendar_unavailable");
    return cal;
  }
  private alias(row: schema.Event): string | undefined {
    const extra = extraOf(row);
    return extra.outlookPairId === this.pairId && typeof extra.outlookOccurrenceKey === "string" ? extra.outlookOccurrenceKey : undefined;
  }
  private item(row: schema.Event, timezone: string, at?: Date): SyncItem {
    const startsAt = at ?? row.startsAt;
    const endsAt = new Date(startsAt.getTime() + row.endsAt.getTime() - row.startsAt.getTime());
    const content = contentSchema.parse({ summary: row.summary, description: row.description ?? "", location: row.location ?? "", startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), allDay: row.allDay });
    return { id: this.alias(row) ?? (row.rrule ? row.id + "@" + startsAt.toISOString() : row.id),
      revision: createHash("sha256").update(JSON.stringify([row, timezone, startsAt])).digest("hex"), content,
      ...(row.uid.startsWith("outlook:") ? { origin: row.uid } : {}) };
  }
  private occurrences(row: schema.Event, cal: schema.Calendar, from: Date, to: Date): Date[] {
    const duration = Math.max(0, row.endsAt.getTime() - row.startsAt.getTime());
    const starts = seriesStartsBetween({ ...row, timeZone: expansionTimeZone({ ...row, calendarTimezone: cal.timezone, rawStartIsUtc: rawIcsStartIsUtc(row.rawIcs) }) }, new Date(from.getTime() - duration), to, 20001);
    // Unlike a display grid, synchronization must never use a truncated or
    // fallback expansion as evidence that an occurrence was deleted.
    if (!starts || starts.length > 20000) throw new SyncUnavailableError("unsupported_recurrence");
    const excluded = exdateMillis(row.exdates as string[] | null);
    return starts.filter(d => !excluded.has(d.getTime()));
  }
  async snapshot(tracked: string[]): Promise<Map<string, SyncItem>> {
    const cal = await this.calendar();
    const rows = await db.select().from(schema.events).where(eq(schema.events.calendarId, this.calendarId)).limit(20001);
    if (rows.length > 20000) throw new SyncUnavailableError("calendar_too_large");
    const items = new Map<string, SyncItem>();
    const aliases = new Map(rows.filter(x => this.alias(x)).map(x => [this.alias(x)!, x]));
    const byId = new Map(rows.map(x => [x.id, x]));
    for (const row of rows) {
      if (row.deletedAt) continue;
      if (row.rrule) {
        for (const at of this.occurrences(row, cal, this.from, this.to)) {
          const item = this.item(row, cal.timezone, at);
          if (!aliases.has(item.id)) items.set(item.id, item);
        }
      } else if (row.startsAt <= this.to && row.endsAt >= this.from) {
        const item = this.item(row, cal.timezone); items.set(item.id, item);
      }
      if (items.size > 20000) throw new SyncUnavailableError("calendar_too_large");
    }
    // A window moving forward, or an editor moving an event outside it, is not
    // a deletion. Resolve every previously linked occurrence independently.
    for (const key of tracked) {
      if (items.has(key)) continue;
      const alias = aliases.get(key);
      if (alias) { if (!alias.deletedAt) items.set(key, this.item(alias, cal.timezone)); continue; }
      const [id, at] = key.split("@");
      const row = byId.get(id!);
      if (!row || row.deletedAt) continue;
      if (!at && !row.rrule) items.set(key, this.item(row, cal.timezone));
      else if (at && row.rrule && Number.isFinite(Date.parse(at))) {
        const date = new Date(at);
        if (this.occurrences(row, cal, date, date).some(x => x.getTime() === date.getTime())) items.set(key, this.item(row, cal.timezone, date));
      }
    }
    return items;
  }
  async findOrigin(origin: string): Promise<SyncItem | { deletedId: string } | null> {
    const cal = await this.calendar();
    const [row] = await db.select().from(schema.events).where(and(eq(schema.events.calendarId, this.calendarId), eq(schema.events.uid, origin)));
    if (row?.deletedAt) return { deletedId: this.alias(row) ?? row.id };
    return row ? this.item(row, cal.timezone) : null;
  }
  async save(content: SyncContent, current?: SyncItem, origin?: string): Promise<SyncItem> {
    content = contentSchema.parse(content);
    const cal = await this.calendar();
    return db.transaction(async tx => {
      const fields = { summary: content.summary, description: content.description, location: content.location,
        startsAt: new Date(content.startsAt), endsAt: new Date(content.endsAt), allDay: content.allDay,
        rawIcs: null, updatedAt: new Date() };
      if (!current) {
        if (!origin?.startsWith("outlook:")) throw new SyncUnavailableError("invalid_sync_origin");
        const [created] = await tx.insert(schema.events).values({ ...fields, calendarId: this.calendarId, uid: origin })
          .onConflictDoNothing({ target: [schema.events.calendarId, schema.events.uid] }).returning();
        const row = created ?? (await tx.select().from(schema.events).where(and(eq(schema.events.calendarId, this.calendarId), eq(schema.events.uid, origin))))[0]!;
        if (row.deletedAt) throw new SyncConflictError();
        return this.item(row, cal.timezone);
      }
      const key = current.id;
      const [id, at] = key.split("@");
      const aliasUid = localOrigin(this.pairId, "occurrence:" + key);
      const [alias] = at ? await tx.select().from(schema.events).where(and(eq(schema.events.calendarId, this.calendarId), eq(schema.events.uid, aliasUid))).for("update") : [];
      const [original] = alias ? [] : await tx.select().from(schema.events).where(and(eq(schema.events.calendarId, this.calendarId), eq(schema.events.id, id!))).for("update");
      const row = alias ?? original;
      if (!row || row.deletedAt || this.item(row, cal.timezone, alias ? undefined : at ? new Date(at) : undefined).revision !== current.revision) throw new SyncConflictError();
      if (at && !alias) {
        const exdates = [...new Set([...(Array.isArray(row.exdates) ? row.exdates as string[] : []), at])];
        await tx.update(schema.events).set({ exdates, updatedAt: new Date() }).where(eq(schema.events.id, row.id));
        const [created] = await tx.insert(schema.events).values({ ...fields, calendarId: this.calendarId, uid: aliasUid,
          extra: { ...extraOf(row), outlookPairId: this.pairId, outlookOccurrenceKey: key } }).returning();
        return this.item(created!, cal.timezone);
      }
      const [updated] = await tx.update(schema.events).set(fields).where(eq(schema.events.id, row.id)).returning();
      return this.item(updated!, cal.timezone);
    });
  }
  async remove(current: SyncItem): Promise<void> {
    const cal = await this.calendar();
    const deleted = await db.transaction(async tx => {
      const [id, at] = current.id.split("@");
      const [alias] = at ? await tx.select().from(schema.events).where(and(eq(schema.events.calendarId, this.calendarId), eq(schema.events.uid, localOrigin(this.pairId, "occurrence:" + current.id)))).for("update") : [];
      const [original] = alias ? [] : await tx.select().from(schema.events).where(and(eq(schema.events.calendarId, this.calendarId), eq(schema.events.id, id!))).for("update");
      const row = alias ?? original;
      if (!row || row.deletedAt) return null;
      if (this.item(row, cal.timezone, alias ? undefined : at ? new Date(at) : undefined).revision !== current.revision) throw new SyncConflictError();
      if (at && !alias) {
        const exdates = [...new Set([...(Array.isArray(row.exdates) ? row.exdates as string[] : []), at])];
        await tx.update(schema.events).set({ exdates, updatedAt: new Date() }).where(eq(schema.events.id, row.id));
        return null;
      }
      await tx.update(schema.events).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.events.id, row.id));
      return row;
    });
    if (deleted) {
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, this.userId));
      if (user) await notifyEventCancellation(deleted, user);
    }
  }
}
