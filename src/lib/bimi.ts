// BIMI (Brand Indicators for Message Identification) helpers.
//
// BIMI shows a brand logo as the sender avatar in supporting inboxes. The logo
// MUST be an SVG Tiny Portable/Secure (SVG P/S) file — a restricted SVG profile:
// square viewBox, a <title>, baseProfile="tiny-ps", and NO scripts / raster
// <image> / animation / external references. A raster PNG can never be made
// compliant (the profile forbids embedded bitmaps), so we only accept SVG and
// validate it here.
//
// These are pure functions (no IO) so they can be unit-tested in isolation.

export type BimiValidation =
  | { ok: true; svg: string; normalized: boolean; notes: string[] }
  | { ok: false; errors: string[] };

// Hard violations — things SVG P/S forbids that we cannot safely auto-fix.
const FORBIDDEN: Array<{ re: RegExp; msg: string }> = [
  { re: /<script[\s/>]/i, msg: "包含 <script>（BIMI 禁止脚本）" },
  { re: /<image[\s/>]/i, msg: "包含 <image>（BIMI 禁止内嵌位图，PNG/JPG 无法用于 BIMI）" },
  { re: /<foreignObject[\s/>]/i, msg: "包含 <foreignObject>" },
  { re: /<(animate|animateTransform|animateMotion|animateColor|set)[\s/>]/i, msg: "包含动画元素（BIMI 禁止动画）" },
  { re: /<a[\s/>]/i, msg: "包含 <a> 超链接" },
  { re: /<use[\s/>]/i, msg: "包含 <use>（外部/内部引用）" },
  { re: /\son[a-z]+\s*=/i, msg: "包含事件处理属性（onload / onclick 等）" },
  { re: /xlink:href\s*=/i, msg: "包含 xlink:href（外部引用）" },
  { re: /href\s*=\s*["']\s*(?:https?:|data:|\/\/)/i, msg: "包含外部 / data: 链接" },
  { re: /url\(\s*["']?\s*(?:https?:|\/\/)/i, msg: "CSS 引用了外部 URL" },
  { re: /@import/i, msg: "CSS 含 @import" },
  { re: /javascript:/i, msg: "含 javascript: 协议" },
];

const MAX_BYTES = 32 * 1024; // BIMI hard limit

function byteLength(s: string): number {
  // Avoid a hard dependency on Node Buffer in this pure module.
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  return s.length;
}

/**
 * Validate an SVG against the enforceable parts of the BIMI SVG P/S profile and,
 * when there are no hard violations, normalize it (inject baseProfile / version /
 * <title> if missing) so it becomes compliant. Non-square viewBox and forbidden
 * content cannot be auto-fixed and are returned as errors.
 */
export function normalizeBimiSvg(input: string, opts: { title: string }): BimiValidation {
  const svg = (input || "").trim();
  const errors: string[] = [];

  if (!/<svg[\s>]/i.test(svg)) {
    return { ok: false, errors: ["不是有效的 SVG（找不到 <svg> 根元素）"] };
  }
  if (byteLength(svg) > MAX_BYTES) errors.push("文件超过 32KB（BIMI 上限）");
  for (const f of FORBIDDEN) if (f.re.test(svg)) errors.push(f.msg);

  const rootMatch = svg.match(/<svg\b([^>]*)>/i);
  const rootAttrs: string = rootMatch?.[1] ?? "";

  // viewBox must exist and be square (logos are 1:1).
  const vb = rootAttrs.match(/viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*["']/i);
  if (!vb) {
    errors.push("根 <svg> 缺少 viewBox");
  } else {
    const wRaw = vb[3] ?? "";
    const hRaw = vb[4] ?? "";
    const w = parseFloat(wRaw);
    const h = parseFloat(hRaw);
    if (!(w > 0 && h > 0) || Math.abs(w - h) > 0.5) {
      errors.push(`viewBox 必须是正方形（宽=高），当前为 ${wRaw}×${hRaw}`);
    }
  }
  // P/S forbids x / y on the root element.
  if (/\sx\s*=/i.test(rootAttrs) || /\sy\s*=/i.test(rootAttrs)) {
    errors.push("根 <svg> 不能有 x / y 属性");
  }

  if (errors.length) return { ok: false, errors };

  // ---- Normalize (only reached when there are no hard violations) ----
  const notes: string[] = [];
  let attrs = rootAttrs;

  if (!/baseProfile\s*=\s*["']tiny-ps["']/i.test(attrs)) {
    attrs = attrs.replace(/\sbaseProfile\s*=\s*["'][^"']*["']/i, "");
    attrs = ` baseProfile="tiny-ps"${attrs}`;
    notes.push('baseProfile="tiny-ps"');
  }
  if (!/version\s*=\s*["']1\.2["']/i.test(attrs)) {
    attrs = attrs.replace(/\sversion\s*=\s*["'][^"']*["']/i, "");
    attrs = ` version="1.2"${attrs}`;
    notes.push('version="1.2"');
  }

  let out = svg;
  if (rootMatch) out = out.replace(rootMatch[0], `<svg${attrs}>`);

  if (!/<title>/i.test(out)) {
    const safeTitle = (opts.title || "").replace(/[<>&]/g, "").trim().slice(0, 64) || "Logo";
    out = out.replace(/(<svg\b[^>]*>)/i, `$1\n  <title>${safeTitle}</title>`);
    notes.push("<title>");
  }

  return { ok: true, svg: out, normalized: notes.length > 0, notes };
}

/** Extract the domain from an email address, lower-cased, or null if invalid. */
export function emailDomain(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  const dom = addr.slice(at + 1).trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(dom) ? dom : null;
}

/**
 * Compute the BIMI DNS TXT record for the sending domain. Returns null when the
 * From address has no usable domain (so the UI can prompt the admin to set it).
 */
export function bimiDnsRecord(opts: {
  fromAddress: string | null | undefined;
  svgUrl: string;
  vmcUrl?: string | null;
}): { host: string; type: "TXT"; value: string } | null {
  const dom = emailDomain(opts.fromAddress);
  if (!dom) return null;
  const vmc = (opts.vmcUrl || "").trim();
  const value = `v=BIMI1; l=${opts.svgUrl};` + (vmc ? ` a=${vmc}` : "");
  return { host: `default._bimi.${dom}`, type: "TXT", value };
}
