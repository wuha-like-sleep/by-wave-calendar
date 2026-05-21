import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";

export const PALETTES = ["indigo", "emerald", "rose", "sky", "amber", "violet", "slate"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;
export type Palette = typeof PALETTES[number];
export type Density = typeof DENSITIES[number];

const COOKIE_PALETTE = "bwc_theme";
const COOKIE_DENSITY = "bwc_density";
const ONE_YEAR = 365 * 24 * 60 * 60;

export function isValidPalette(s: unknown): s is Palette {
  return typeof s === "string" && (PALETTES as readonly string[]).includes(s);
}
export function isValidDensity(s: unknown): s is Density {
  return typeof s === "string" && (DENSITIES as readonly string[]).includes(s);
}

export function setThemeCookies(reply: FastifyReply, palette: string | null, density: string | null): void {
  const opts = {
    httpOnly: false, // JS-readable so client can mirror without round-trip; not sensitive
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR,
  };
  if (palette && isValidPalette(palette)) reply.setCookie(COOKIE_PALETTE, palette, opts);
  else reply.clearCookie(COOKIE_PALETTE, { path: "/" });
  if (density && isValidDensity(density)) reply.setCookie(COOKIE_DENSITY, density, opts);
  else reply.clearCookie(COOKIE_DENSITY, { path: "/" });
}

export function clearThemeCookies(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_PALETTE, { path: "/" });
  reply.clearCookie(COOKIE_DENSITY, { path: "/" });
}

export function readThemeFromRequest(req: FastifyRequest): { palette?: Palette; density?: Density } {
  const out: { palette?: Palette; density?: Density } = {};
  const p = req.cookies[COOKIE_PALETTE];
  if (isValidPalette(p)) out.palette = p;
  const d = req.cookies[COOKIE_DENSITY];
  if (isValidDensity(d)) out.density = d;
  return out;
}
