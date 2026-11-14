// Reproducible native assets from the repository's vector brand mark.
// Run from the repository root: node scripts/build-desktop-branding.mjs
import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const out = 'apps/desktop/packaging';
await mkdir(out, { recursive: true });
const svg = await readFile('src/public/favicon.svg');
const png = size => sharp(svg).resize(size, size).png().toBuffer();
await writeFile(out + '/icon.png', await png(512));
await writeFile('apps/desktop/src/main/resources/brand-icon.png', await png(128));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const entries = await Promise.all(sizes.map(png));
const header = Buffer.alloc(6 + sizes.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
entries.forEach((data, i) => {
  const at = 6 + i * 16; header[at] = sizes[i] % 256; header[at + 1] = sizes[i] % 256;
  header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(data.length, at + 8); header.writeUInt32LE(offset, at + 12); offset += data.length;
});
await writeFile(out + '/icon.ico', Buffer.concat([header, ...entries]));
const macSvg = await readFile(out + '/macos-icon.svg');
const macSmallSvg = await readFile(out + '/macos-icon-small.svg');
const macPng = size => sharp(size <= 64 ? macSmallSvg : macSvg).resize(size, size).png().toBuffer();
await writeFile('apps/desktop/src/main/resources/brand-icon-macos.png', await macPng(128));
const chunks = [];
// Include Finder list sizes and their Retina representations, not just Dock sizes.
for (const [tag, size] of [['icp4',16],['icp5',32],['ic07',128],['ic08',256],['ic09',512],['ic10',1024],['ic11',32],['ic12',64],['ic13',256],['ic14',512]]) {
  const data = await macPng(size), h = Buffer.alloc(8); h.write(tag); h.writeUInt32BE(data.length + 8, 4); chunks.push(h, data);
}
const icns = Buffer.alloc(8); icns.write('icns'); icns.writeUInt32BE(8 + chunks.reduce((sum,c) => sum + c.length, 0), 4);
await writeFile(out + '/icon.icns', Buffer.concat([icns, ...chunks]));
await writeFile(out + '/ByWaveCalendar-volume.icns', Buffer.concat([icns, ...chunks]));
const dmg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="340"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#fafbff"/><stop offset="1" stop-color="#eeecff"/></linearGradient></defs><rect width="520" height="340" fill="url(#bg)"/><text x="260" y="32" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="600" fill="#252a43">ByWave Calendar</text><rect x="34" y="55" width="172" height="174" rx="22" fill="#fff" stroke="#e0e3f0"/><rect x="304" y="55" width="172" height="174" rx="22" fill="#fff" stroke="#e0e3f0"/><path d="M229 130h48m-10-10 10 10-10 10" fill="none" stroke="#7066dd" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><text x="260" y="253" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="600" fill="#333953">Drag to Applications</text><text x="260" y="274" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#68718b">Your calendar. Your space.</text></svg>`;
await writeFile(out + '/dmg-background.svg', dmg);
await sharp(Buffer.from(dmg), { density: 144 }).tiff({ compression: 'lzw', xres: 144 / 25.4, yres: 144 / 25.4 }).toFile(out + '/ByWaveCalendar-background.tiff');
// WiX renders its own labels over the right side; keep that region clear.
const dialog = `<svg xmlns="http://www.w3.org/2000/svg" width="493" height="312"><defs><linearGradient id="b" x2="0.8" y2="1"><stop stop-color="#6366f1"/><stop offset="1" stop-color="#34289c"/></linearGradient></defs><rect width="493" height="312" fill="#fff"/><path d="M0 0h164v312H0z" fill="url(#b)"/><rect x="30" y="32" width="48" height="48" rx="11" fill="#fff" fill-opacity=".15"/><rect x="41" y="49" width="26" height="22" rx="3" fill="#fff"/><path d="M41 55h26" stroke="#4338ca" stroke-width="5"/><circle cx="48" cy="45" r="2" fill="#fff"/><circle cx="60" cy="45" r="2" fill="#fff"/><text x="28" y="118" font-family="Arial,sans-serif" font-size="24" font-weight="600" fill="#fff">ByWave</text><text x="28" y="145" font-family="Arial,sans-serif" font-size="18" fill="#e5e3ff">Calendar</text><path d="M28 171h36" stroke="#b8b3ff" stroke-width="2"/><text x="28" y="259" font-family="Arial,sans-serif" font-size="12" fill="#e5e3ff">Your calendar.</text><text x="28" y="278" font-family="Arial,sans-serif" font-size="12" fill="#e5e3ff">Your space.</text></svg>`;
const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="493" height="58"><rect width="493" height="58" fill="#fff"/><rect x="0" y="56" width="493" height="2" fill="#eeecff"/><rect x="443" y="12" width="32" height="32" rx="8" fill="#4f46e5"/><rect x="451" y="23" width="16" height="14" rx="2" fill="#fff"/><path d="M451 27h16" stroke="#312e81" stroke-width="4"/><circle cx="455" cy="21" r="1.5" fill="#fff"/><circle cx="463" cy="21" r="1.5" fill="#fff"/></svg>`;
async function bmp(svg, path) {
  const {data,info} = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const stride = Math.ceil(info.width * 3 / 4) * 4, buffer = Buffer.alloc(54 + stride * info.height);
  buffer.write('BM'); buffer.writeUInt32LE(buffer.length,2); buffer.writeUInt32LE(54,10); buffer.writeUInt32LE(40,14); buffer.writeInt32LE(info.width,18); buffer.writeInt32LE(info.height,22); buffer.writeUInt16LE(1,26); buffer.writeUInt16LE(24,28); buffer.writeUInt32LE(stride*info.height,34);
  for(let y=0;y<info.height;y++) for(let x=0;x<info.width;x++) {const src=(y*info.width+x)*3,dst=54+(info.height-1-y)*stride+x*3;buffer[dst]=data[src+2];buffer[dst+1]=data[src+1];buffer[dst+2]=data[src];}
  await writeFile(path,buffer);
}
await writeFile(out + '/windows-dialog.svg', dialog); await writeFile(out + '/windows-banner.svg', banner);
await bmp(dialog, out + '/WinDialog.bmp'); await bmp(banner, out + '/WinBanner.bmp');
console.log('Generated desktop icons and installer branding.');
