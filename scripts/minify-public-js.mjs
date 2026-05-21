// Minify + mangle our public JS for production. Output goes to
// src/public/_built/<file>.js (gitignored) so the source files in src/public/
// stay readable and diff-clean during development; the layout serves from
// /static/_built/ when running with NODE_ENV=production.
import { readFile, writeFile, readdir, stat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..", "src", "public");
const OUT = path.join(SRC, "_built");

const SKIP_DIRS = new Set(["lib", "uploads", "css", "_built"]);

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir)) {
    const full = path.join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...(await walk(full, base)));
    } else if (entry.endsWith(".js") && !entry.endsWith(".min.js")) {
      out.push({ full, rel: path.relative(base, full) });
    }
  }
  return out;
}

async function main() {
  if (process.env.NODE_ENV !== "production") {
    console.log(`[minify] NODE_ENV=${process.env.NODE_ENV || "(unset)"} — skipping in non-production build. Source files untouched.`);
    return;
  }
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const files = await walk(SRC);
  let totalIn = 0, totalOut = 0;
  for (const f of files) {
    const src = await readFile(f.full, "utf8");
    totalIn += src.length;
    const result = await minify({ [path.basename(f.rel)]: src }, {
      compress: { passes: 2, drop_console: false, dead_code: true },
      mangle: { toplevel: false, reserved: ["window", "document", "fetch"] },
      format: { comments: false, ascii_only: true },
      sourceMap: false,
    });
    if (result.error) throw result.error;
    if (!result.code) throw new Error(`no output for ${f.rel}`);
    const outFile = path.join(OUT, f.rel);
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, result.code, "utf8");
    totalOut += result.code.length;
    console.log(`[minify] ${f.rel}: ${src.length} → ${result.code.length} (${((1 - result.code.length / src.length) * 100).toFixed(1)}% off)`);
  }
  console.log(`[minify] total: ${totalIn} → ${totalOut} (${((1 - totalOut / totalIn) * 100).toFixed(1)}% off across ${files.length} files)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
