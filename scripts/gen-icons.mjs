// Generate PNG icons from an inline SVG. Run via `node scripts/gen-icons.mjs`.
// Output: src/public/icons/{icon-192,icon-512,icon-192-maskable,icon-512-maskable}.png
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const outDir = join(process.cwd(), "src", "public", "icons");
mkdirSync(outDir, { recursive: true });

const baseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#4338ca"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="url(#g)"/>
  <rect x="120" y="172" width="272" height="240" rx="32" fill="#ffffff"/>
  <rect x="120" y="172" width="272" height="56" fill="#312e81"/>
  <circle cx="180" cy="140" r="20" fill="#ffffff"/>
  <circle cx="332" cy="140" r="20" fill="#ffffff"/>
  <text x="256" y="350" font-family="system-ui, -apple-system, sans-serif" font-size="140" font-weight="800" fill="#312e81" text-anchor="middle">31</text>
</svg>`;

// Maskable adds a safe padding zone (the icon content should sit within the inner 80% circle).
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g2" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#4338ca"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#g2)"/>
  <rect x="156" y="200" width="200" height="180" rx="24" fill="#ffffff"/>
  <rect x="156" y="200" width="200" height="42" fill="#312e81"/>
  <circle cx="200" cy="180" r="15" fill="#ffffff"/>
  <circle cx="312" cy="180" r="15" fill="#ffffff"/>
  <text x="256" y="340" font-family="system-ui, -apple-system, sans-serif" font-size="105" font-weight="800" fill="#312e81" text-anchor="middle">31</text>
</svg>`;

async function emit(svg, size, name) {
  const out = join(outDir, name);
  await sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
  console.log(`  ${name} (${size}x${size})`);
}

console.log("[gen-icons] writing PNGs to", outDir);
await emit(baseSvg, 192, "icon-192.png");
await emit(baseSvg, 512, "icon-512.png");
await emit(maskableSvg, 192, "icon-192-maskable.png");
await emit(maskableSvg, 512, "icon-512-maskable.png");
console.log("[gen-icons] done");
