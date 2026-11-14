// One vector identity, with optical sizing and platform-specific framing.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

const master = await readFile(new URL('../src/public/brand/logo.svg', import.meta.url), 'utf8');
const small = await readFile(new URL('../src/public/brand/logo-small.svg', import.meta.url), 'utf8');

export function brandSvg(size, variant = 'standard') {
  if (variant === 'standard') return size <= 64 ? small : master;
  const tile = /<g id="brand-tile">[\s\S]*?<\/g>/;
  if (variant === 'full-bleed') {
    return master.replace(tile, '<rect width="1024" height="1024" fill="url(#tile)"/><rect width="1024" height="1024" fill="url(#light)"/>');
  }
  if (variant === 'background') {
    return master.slice(0, master.indexOf('<g id="brand-tile">')) + '<rect width="1024" height="1024" fill="url(#tile)"/><rect width="1024" height="1024" fill="url(#light)"/></svg>';
  }
  if (variant === 'foreground') {
    // Android's 108dp layer: keep the calendar inside the central 66dp circle.
    return master.replace(tile, '').replace('<g id="brand-mark">', '<g id="brand-mark" transform="translate(112.64 112.64) scale(.78)">');
  }
  if (variant === 'monochrome') {
    // Keep the wave and divider visible as cutouts when Android tints the layer.
    const mark = small.match(/<g id="brand-mark">([\s\S]*?)<\/g>/)[1]
      .replaceAll('#FAF9FF', '#FFFFFF').replaceAll('#E3DEF7', '#000000').replaceAll('#6953D7', '#000000');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs><mask id="mark"><g transform="translate(3.52 3.52) scale(.78)">${mark}</g></mask></defs><rect width="32" height="32" fill="#FFFFFF" mask="url(#mark)"/></svg>`;
  }
  throw new Error(`Unknown brand variant: ${variant}`);
}

export async function brandPng(size, variant = 'standard') {
  let image = sharp(Buffer.from(brandSvg(size, variant))).resize(size, size);
  if (variant === 'full-bleed' || variant === 'background') image = image.removeAlpha();
  return image.png({ compressionLevel: 9 }).toBuffer();
}

export function brandDataUri(size) {
  return 'data:image/svg+xml;base64,' + Buffer.from(brandSvg(size)).toString('base64');
}
