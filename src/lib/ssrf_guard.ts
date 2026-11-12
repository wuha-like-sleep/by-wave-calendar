// SSRF guard for outbound fetches that target a *user-supplied* URL.
//
// The threat: any logged-in user can add an ICS subscription (src/lib/
// ics_import.ts → fetchIcsUrl) pointing at an arbitrary URL, and the
// server will fetch it — on every manual refresh AND on the 5-minute
// background scheduler tick. Without validation that's a textbook SSRF:
// the attacker can reach
//   - cloud metadata (http://169.254.169.254/latest/meta-data/…),
//   - localhost-only admin panels (http://127.0.0.1:…),
//   - internal RFC-1918 / ULA hosts the server can route to.
//
// What we enforce:
//   1. Protocol allowlist — http / https only (no file:, gopher:, ftp:, …).
//   2. No embedded credentials (user:pass@) — a common bypass vector.
//   3. DNS-resolve the hostname and reject if *any* resolved address is
//      private / loopback / link-local / reserved / multicast.
//   4. Re-validate on every redirect hop (we follow redirects manually) —
//      an upstream 302 to http://127.0.0.1/ is otherwise a trivial bypass.
//
// The connection resolver also validates the exact addresses returned to the
// socket. DNS changes between the preliminary check and connection therefore
// cannot redirect a request into the private network. The URL host stays intact
// for HTTP Host and TLS SNI/certificate validation.
//
// Self-hosters who genuinely need to pull an ICS feed from an internal
// host can set ICS_ALLOW_PRIVATE_NETWORK=true to opt out of the IP-range
// block (protocol/credential checks still apply). Off by default — secure
// unless the operator deliberately relaxes it.

import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** Parse an IPv4 dotted-quad into its 4 octets, or null if not IPv4. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts as [number, number, number, number];
}

/**
 * True if `ip` (a numeric IPv4 or IPv6 literal) points at a target we must
 * never let user-supplied URLs reach: loopback, private ranges, link-local
 * (incl. the cloud-metadata 169.254.169.254), reserved, multicast, etc.
 *
 * Exported for unit testing.
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 0) return true; // not a valid IP literal → fail closed

  if (kind === 4) {
    const oc = ipv4Octets(ip);
    if (!oc) return true;
    const [a, b] = oc;
    if (a === 0) return true;                       // 0.0.0.0/8 "this network"
    if (a === 10) return true;                      // 10.0.0.0/8 private
    if (a === 127) return true;                     // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local (cloud metadata!)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16 private
    if (a === 192 && b === 0 && oc[2] === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                      // 224.0.0.0/4 multicast + 240/4 reserved + 255.255.255.255
    return false;
  }

  // IPv6
  const lower = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
  // IPv4-mapped / -compatible (::ffff:a.b.c.d, ::a.b.c.d) — extract the v4 tail and re-check.
  const v4Tail = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail) return isBlockedAddress(v4Tail[1]!);
  if (lower === "::" || lower === "::1") return true; // unspecified / loopback
  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique-local
  if (lower.startsWith("ff")) return true;          // ff00::/8 multicast
  if (lower.startsWith("::ffff:")) return true;     // any other mapped form, fail closed
  return false;
}

/**
 * Validate a single URL for outbound fetch: protocol + no-credentials +
 * DNS-resolve-and-classify. Throws SsrfBlockedError on any violation.
 * Returns the parsed URL on success.
 *
 * @param allowPrivate when true, skip the IP-range block (operator opt-in).
 */
export async function validateOutboundUrl(rawUrl: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("URL 无法解析");
  }
  const proto = url.protocol.toLowerCase();
  if (proto !== "http:" && proto !== "https:") {
    throw new SsrfBlockedError("仅允许 http(s):// 协议");
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError("URL 不允许包含用户名/密码");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literalKind = isIP(host);
  if (literalKind !== 0) {
    if (!allowPrivate && isBlockedAddress(host)) {
      throw new SsrfBlockedError("目标地址指向内网 / 保留地址，已拒绝");
    }
    return url;
  }

  // Resolve ALL addresses; reject if ANY one is internal. An attacker can
  // return both a public and an internal A record; since undici may connect
  // to any of them, requiring all-clear is the only safe rule.
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError("无法解析主机名");
  }
  if (records.length === 0) throw new SsrfBlockedError("主机名没有解析到任何地址");
  if (!allowPrivate) {
    for (const r of records) {
      if (isBlockedAddress(r.address)) {
        throw new SsrfBlockedError("目标主机解析到内网 / 保留地址，已拒绝");
      }
    }
  }
  return url;
}

/** Return only vetted addresses to the socket, with no subsequent DNS lookup. */
export function createPublicAddressLookup(resolve = lookup): LookupFunction {
  return (hostname, options, callback) => {
    void resolve(hostname, { all: true }).then((records) => {
      if (!records.length || records.some((r) => isBlockedAddress(r.address))) {
        callback(new SsrfBlockedError("连接地址指向内网 / 保留地址，已拒绝"), "", 4);
        return;
      }
      const family = options.family;
      const requestedFamily = family === "IPv4" ? 4 : family === "IPv6" ? 6 : family;
      const usable = requestedFamily ? records.filter((r) => r.family === requestedFamily) : records;
      if (!usable.length) {
        callback(new SsrfBlockedError("目标主机没有可用地址"), "", 4);
      } else if (options.all) {
        callback(null, usable);
      } else {
        callback(null, usable[0]!.address, usable[0]!.family);
      }
    }, (error: NodeJS.ErrnoException) => callback(error, "", 4));
  };
}

const publicAddressAgent = new Agent({ connect: { lookup: createPublicAddressLookup() } });

/**
 * SSRF-safe fetch for user-supplied URLs. Follows redirects manually,
 * re-validating each hop (the upstream can 302 you to an internal host).
 * The connection resolver validates the final address while preserving the
 * original hostname for TLS verification.
 *
 * Mirrors the parts of the WHATWG fetch options we actually use.
 */
export async function safeFetch(
  rawUrl: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    allowPrivate?: boolean;
    maxRedirects?: number;
  } = {},
): Promise<Response> {
  const allowPrivate = opts.allowPrivate ?? false;
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await validateOutboundUrl(current, allowPrivate);

    const resp = await fetch(url.toString(), {
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body,
      redirect: "manual", // follow manually so we can re-validate each hop
      signal: opts.signal,
      // Node's bundled fetch types may target an older undici version; both
      // implementations accept the same Dispatcher protocol at runtime.
      ...(!allowPrivate ? { dispatcher: publicAddressAgent as unknown as import("undici-types").Dispatcher } : {}),
    });

    // 3xx with a Location → re-validate the target and continue.
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return resp; // no Location; treat as a (weird) terminal response
      // Redirect bodies are untrusted too: do not buffer an unlimited body
      // before applying the caller's response-size limit to the final hop.
      try { await resp.body?.cancel(); } catch { /* already closed or aborted */ }
      if (hop === maxRedirects) {
        throw new SsrfBlockedError("重定向次数过多");
      }
      // Resolve relative redirects against the current URL.
      current = new URL(loc, url).toString();
      continue;
    }

    return resp;
  }
  throw new SsrfBlockedError("重定向次数过多");
}
