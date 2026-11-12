import { z } from "zod";
import { contentSchema, SyncConflictError, SyncUnavailableError, type SyncContent, type SyncItem } from "./model.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const LOGIN = "https://login.microsoftonline.com/common/oauth2/v2.0";
const SCOPES = "https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read offline_access";
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive() });
export type MicrosoftTokens = z.infer<typeof tokenSchema>;
const eventSchema = z.object({
  id: z.string().min(1), "@odata.etag": z.string().optional(), changeKey: z.string().min(1),
  subject: z.string().nullable().optional(), body: z.object({ content: z.string(), contentType: z.string() }).optional(),
  location: z.object({ displayName: z.string().nullable().optional() }).optional(),
  start: z.object({ dateTime: z.string(), timeZone: z.string() }), end: z.object({ dateTime: z.string(), timeZone: z.string() }),
  isAllDay: z.boolean(), isCancelled: z.boolean().optional(), originalStartTimeZone: z.string().optional(),
  transactionId: z.string().nullable().optional(), type: z.string().optional(),
});
export type MicrosoftEvent = z.infer<typeof eventSchema>;
export class MicrosoftError extends SyncUnavailableError {
  constructor(public readonly status: number, code = "microsoft_unavailable", public readonly retryAfter = 60) { super(code); }
}
export function graphUrl(value: string): string {
  const url = new URL(value.startsWith("/") ? GRAPH + value : value);
  if (url.origin !== "https://graph.microsoft.com" || !(url.pathname === "/v1.0/me" || url.pathname.startsWith("/v1.0/me/")) || url.username || url.password || url.hash) {
    throw new SyncUnavailableError("invalid_microsoft_link");
  }
  return url.toString();
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new SyncUnavailableError("microsoft_response_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export class MicrosoftClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}
  async request(path: string, method = "GET", body?: unknown, revision?: string, timezone = "UTC"): Promise<unknown> {
    if (!/^[A-Za-z0-9_+./() -]{1,100}$/.test(timezone)) throw new SyncUnavailableError("unsupported_timezone");
    const response = await this.fetcher(graphUrl(path), {
      method, redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: "Bearer " + this.token,
        Prefer: 'IdType="ImmutableId", outlook.body-content-type="text", outlook.timezone="' + timezone + '"',
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(revision ? { "If-Match": revision } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 412) { await response.body?.cancel(); throw new SyncConflictError(); }
    if (!response.ok) {
      await response.body?.cancel();
      const delay = Math.min(3600, Math.max(30, Number(response.headers.get("retry-after")) || 60));
      throw new MicrosoftError(response.status, response.status === 401 ? "microsoft_reconnect" : "microsoft_unavailable", delay);
    }
    if (response.status === 204) return null;
    return boundedJson(response);
  }
  async pages(path: string): Promise<unknown[]> {
    const result: unknown[] = [], visited = new Set<string>();
    let next: string | undefined = path;
    while (next) {
      const url = graphUrl(next);
      if (visited.has(url) || visited.size >= 100) throw new SyncUnavailableError("microsoft_incomplete_snapshot");
      visited.add(url);
      const page = z.object({ value: z.array(z.unknown()), "@odata.nextLink": z.string().optional() }).parse(await this.request(url));
      result.push(...page.value);
      if (result.length > 20000) throw new SyncUnavailableError("calendar_too_large");
      next = page["@odata.nextLink"];
    }
    return result;
  }
  async account() {
    return z.object({ id: z.string(), mail: z.string().nullable().optional(), userPrincipalName: z.string().optional(), displayName: z.string().nullable().optional() })
      .parse(await this.request("/me?$select=id,mail,userPrincipalName,displayName"));
  }
  async calendars() {
    return z.array(z.object({ id: z.string(), name: z.string(), canEdit: z.boolean().default(false) }))
      .parse(await this.pages("/me/calendars?$select=id,name,canEdit")).filter(c => c.canEdit);
  }
  async createCalendar(name: string) {
    return z.object({ id: z.string(), name: z.string() }).parse(await this.request("/me/calendars", "POST", { name, color: "lightBlue" }));
  }
  private eventPath(calendarId: string, id: string) { return "/me/calendars/" + encodeURIComponent(calendarId) + "/events/" + encodeURIComponent(id); }
  async get(calendarId: string, id: string): Promise<SyncItem | null> {
    try { return this.item(calendarId, eventSchema.parse(await this.request(this.eventPath(calendarId, id)))); }
    catch (e) { if (e instanceof MicrosoftError && e.status === 404) return null; throw e; }
  }
  private async item(calendarId: string, event: MicrosoftEvent): Promise<SyncItem | null> {
    if (event.isCancelled) return null;
    // UTC conversion can move an all-day date to the previous day. Retrieve its
    // original zone before extracting the civil date (including Windows zones).
    if (event.isAllDay && event.originalStartTimeZone && event.originalStartTimeZone !== "UTC") {
      event = eventSchema.parse(await this.request(this.eventPath(calendarId, event.id), "GET", undefined, undefined, event.originalStartTimeZone));
    }
    return microsoftItem(event);
  }
  async snapshot(calendarId: string, from: string, to: string, tracked: string[]): Promise<Map<string, SyncItem>> {
    // A missing or revoked calendar is an error, never an empty event list.
    const calendar = z.object({ canEdit: z.boolean() }).parse(await this.request("/me/calendars/" + encodeURIComponent(calendarId) + "?$select=canEdit"));
    if (!calendar.canEdit) throw new SyncUnavailableError("calendar_read_only");
    const query = new URLSearchParams({ startDateTime: from, endDateTime: to, "$top": "100" });
    const rows = await this.pages("/me/calendars/" + encodeURIComponent(calendarId) + "/calendarView?" + query);
    const items = new Map<string, SyncItem>();
    for (const row of rows) { const item = await this.item(calendarId, eventSchema.parse(row)); if (item) items.set(item.id, item); }
    for (const id of tracked) { if (!items.has(id)) { const item = await this.get(calendarId, id); if (item) items.set(id, item); } }
    // Recheck after pagination: deleting the entire calendar mid-snapshot must
    // not turn a batch of event 404s into deletions on the other platform.
    const stillPresent = z.object({ canEdit: z.boolean() }).parse(await this.request("/me/calendars/" + encodeURIComponent(calendarId) + "?$select=canEdit"));
    if (!stillPresent.canEdit) throw new SyncUnavailableError("calendar_read_only");
    return items;
  }
  async findOrigin(calendarId: string, origin: string): Promise<SyncItem | null> {
    // Only needed to recover an interrupted create. Enumerating every event
    // also finds a newly-created item that an editor moved outside the window.
    const rows = await this.pages("/me/calendars/" + encodeURIComponent(calendarId) + "/events?$top=100");
    for (const row of rows) {
      const event = eventSchema.parse(row);
      if (event.transactionId === origin) return this.item(calendarId, event);
    }
    return null;
  }
  async save(calendarId: string, content: SyncContent, current?: SyncItem, transactionId?: string): Promise<SyncItem> {
    const path = current ? this.eventPath(calendarId, current.id) : "/me/calendars/" + encodeURIComponent(calendarId) + "/events";
    const body = {
      subject: content.summary, body: { contentType: "text", content: content.description },
      location: { displayName: content.location }, isAllDay: content.allDay,
      start: { dateTime: content.startsAt.replace(/Z$/, ""), timeZone: "UTC" },
      end: { dateTime: content.endsAt.replace(/Z$/, ""), timeZone: "UTC" },
      ...(!current && transactionId ? { transactionId } : {}),
    };
    const result = await this.item(calendarId, eventSchema.parse(await this.request(path, current ? "PATCH" : "POST", body, current?.revision)));
    if (!result) throw new SyncConflictError();
    return result;
  }
  async remove(calendarId: string, current: SyncItem): Promise<void> {
    try { await this.request(this.eventPath(calendarId, current.id), "DELETE", undefined, current.revision); }
    catch (e) { if (!(e instanceof MicrosoftError && e.status === 404)) throw e; }
  }
}
export function microsoftItem(event: MicrosoftEvent): SyncItem {
  if (event.body?.contentType.toLowerCase() === "html") throw new SyncUnavailableError("microsoft_text_response_required");
  const instant = (value: string) => new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : value + "Z").toISOString();
  const date = (value: string) => value.slice(0, 10) + "T00:00:00.000Z";
  const content = contentSchema.parse({
    summary: event.subject?.trim() || "Untitled", description: event.body?.content ?? "", location: event.location?.displayName ?? "",
    startsAt: event.isAllDay ? date(event.start.dateTime) : instant(event.start.dateTime),
    endsAt: event.isAllDay ? date(event.end.dateTime) : instant(event.end.dateTime), allDay: event.isAllDay,
  });
  if (content.endsAt <= content.startsAt) throw new SyncUnavailableError("invalid_event_dates");
  return { id: event.id, revision: event["@odata.etag"] ?? 'W/"' + event.changeKey + '"', content, ...(event.transactionId ? { origin: event.transactionId } : {}) };
}
async function authorization(path: string, fields: Record<string, string>, fetcher: typeof fetch = fetch) {
  const response = await fetcher(LOGIN + path, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000), headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  const body = await boundedJson(response);
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(body);
    const allowed = ["authorization_pending", "slow_down", "authorization_declined", "expired_token", "bad_verification_code", "invalid_grant"];
    const code = parsed.success && allowed.includes(parsed.data.error) ? parsed.data.error : "microsoft_authorization_failed";
    throw new MicrosoftError(response.status, code);
  }
  return body;
}
export async function startMicrosoftLogin(clientId: string) {
  const result = z.object({ device_code: z.string(), user_code: z.string(), verification_uri: z.string().url(), expires_in: z.number().positive().max(1800), interval: z.number().positive().default(5) })
    .parse(await authorization("/devicecode", { client_id: clientId, scope: SCOPES }));
  if (!["https://microsoft.com/devicelogin", "https://www.microsoft.com/devicelogin"].includes(result.verification_uri)) throw new SyncUnavailableError("invalid_microsoft_link");
  return result;
}
export async function pollMicrosoftLogin(clientId: string, code: string): Promise<MicrosoftTokens> {
  return tokenSchema.parse(await authorization("/token", { client_id: clientId, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code }));
}
export async function refreshMicrosoftLogin(clientId: string, refreshToken: string): Promise<MicrosoftTokens> {
  return tokenSchema.parse(await authorization("/token", { client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken, scope: SCOPES }));
}
