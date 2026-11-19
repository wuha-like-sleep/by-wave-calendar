import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";

export const PALETTES = ["indigo", "emerald", "rose", "sky", "amber", "violet", "slate"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;
export const MODES = ["system", "light", "dark"] as const;
export type Palette = typeof PALETTES[number];
export type Density = typeof DENSITIES[number];
export type Mode = typeof MODES[number];

const COOKIE_PALETTE = "bwc_theme";
const COOKIE_DENSITY = "bwc_density";
const COOKIE_MODE = "bwc_mode";
const ONE_YEAR = 365 * 24 * 60 * 60;

export function isValidPalette(s: unknown): s is Palette {
  return typeof s === "string" && (PALETTES as readonly string[]).includes(s);
}
export function isValidDensity(s: unknown): s is Density {
  return typeof s === "string" && (DENSITIES as readonly string[]).includes(s);
}
export function isValidMode(s: unknown): s is Mode {
  return typeof s === "string" && (MODES as readonly string[]).includes(s);
}

const COOKIE_OPTS = {
  httpOnly: false, // JS-readable so client can mirror without round-trip; not sensitive
  sameSite: "lax" as const,
  path: "/",
  maxAge: ONE_YEAR,
};

export function setThemeCookies(reply: FastifyReply, palette: string | null, density: string | null): void {
  const opts = { ...COOKIE_OPTS, secure: env.NODE_ENV === "production" };
  if (palette && isValidPalette(palette)) reply.setCookie(COOKIE_PALETTE, palette, opts);
  else reply.clearCookie(COOKIE_PALETTE, { path: "/" });
  if (density && isValidDensity(density)) reply.setCookie(COOKIE_DENSITY, density, opts);
  else reply.clearCookie(COOKIE_DENSITY, { path: "/" });
}

// The colour mode rides its own cookie (same shape as palette/density) so
// the layout can resolve it before first paint: server renders the cookie
// value into <html data-mode-pref>, and an inline script turns "system"
// into the OS preference synchronously — no flash of the wrong theme.
export function setModeCookie(reply: FastifyReply, mode: string | null): void {
  const opts = { ...COOKIE_OPTS, secure: env.NODE_ENV === "production" };
  if (mode && isValidMode(mode)) reply.setCookie(COOKIE_MODE, mode, opts);
  else reply.clearCookie(COOKIE_MODE, { path: "/" });
}

export function clearThemeCookies(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_PALETTE, { path: "/" });
  reply.clearCookie(COOKIE_DENSITY, { path: "/" });
  reply.clearCookie(COOKIE_MODE, { path: "/" });
}

export function readThemeFromRequest(req: FastifyRequest): { palette?: Palette; density?: Density; mode?: Mode } {
  const out: { palette?: Palette; density?: Density; mode?: Mode } = {};
  const p = req.cookies[COOKIE_PALETTE];
  if (isValidPalette(p)) out.palette = p;
  const d = req.cookies[COOKIE_DENSITY];
  if (isValidDensity(d)) out.density = d;
  const m = req.cookies[COOKIE_MODE];
  if (isValidMode(m)) out.mode = m;
  return out;
}
