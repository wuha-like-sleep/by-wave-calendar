import type { FastifyReply, FastifyRequest } from "fastify";
import { FLASH_COOKIE, readFlash } from "../../src/lib/flash.js";

export function flashCookie(res: { cookies: Array<{ name: string; value: string }> }): string {
  const found = res.cookies.find((cookie) => cookie.name === FLASH_COOKIE);
  if (!found) throw new Error("Expected redirect feedback cookie");
  return `${FLASH_COOKIE}=${encodeURIComponent(found.value)}`;
}

/** Inspect feedback using the same authenticated decoder as the destination. */
export function redirectFlash(res: { cookies: Array<{ name: string; value: string }>; headers: Record<string, unknown> }, sid?: string) {
  const found = res.cookies.find((cookie) => cookie.name === FLASH_COOKIE);
  const req = { method: "GET", url: String(res.headers.location), cookies: { [FLASH_COOKIE]: found?.value, bwc_sid: sid } } as unknown as FastifyRequest;
  const reply = { clearCookie() {}, header() {} } as unknown as FastifyReply;
  return readFlash(req, reply);
}
