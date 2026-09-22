import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFile, mkdtemp, rm, mkdir, copyFile, cp, stat } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const CWD = process.cwd();
const STEP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per step

export type UpdateStatus = {
  remote: string;
  branch: string;
  currentSha: string;
  currentSubject: string;
  remoteSha: string | null;
  behind: number;
  newCommits: { sha: string; subject: string; date: string }[];
  hasLocalChanges: boolean;
};

async function run(cmd: string, args: string[], timeoutMs = STEP_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return exec(cmd, args, { cwd: CWD, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
}

/**
 * 定位 npm，**不依赖 PATH**。
 *
 * 为什么需要这个：更新流程用 execFile 调 npm，而 execFile 不走 shell，
 * 完全靠 PATH 查找。PM2 托管的进程拿到的 PATH 往往是精简的——宝塔面板启动、
 * 或 Node 装在 nvm/自定义前缀下时，npm 根本不在里面。结果就是后台点「更新」
 * 走到装依赖那一步直接 `spawn npm ENOENT`，而此时新版本的文件**已经覆盖上去了**，
 * 系统停在一个「代码是新的、依赖是旧的」的半更新状态。线上真出过这个事故。
 *
 * 解析顺序：
 *   1. NPM_BIN 环境变量（运维显式指定，优先级最高）
 *   2. 从 process.execPath 反推——npm 和 node 装在一起，
 *      这条同时保证用的是**同一个 Node**，不会出现 node 20 跑着、
 *      npm 却挂在另一个 node 18 上的错配
 *   3. 几个常见绝对路径
 *   4. 都找不到才退回 "npm"，让 PATH 碰运气（并在报错里说清楚怎么修）
 *
 * 返回 npm-cli.js 时用 [node, cli.js, ...args] 调用，比调 npm 这个 shell
 * 包装脚本更稳（不受 shebang 和符号链接影响）。
 */
function resolveNpm(): { cmd: string; prefixArgs: string[]; how: string } {
  const fromEnv = process.env.NPM_BIN;
  if (fromEnv) return { cmd: fromEnv, prefixArgs: [], how: "NPM_BIN 环境变量" };

  const nodeDir = path.dirname(process.execPath);
  const candidates: { file: string; viaNode: boolean; how: string }[] = [
    // npm 的入口 JS —— 最稳，直接用当前 node 执行
    { file: path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), viaNode: true, how: "随 node 安装的 npm-cli.js" },
    { file: path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), viaNode: true, how: "node 同级的 npm-cli.js" },
    // 再退到 npm 包装脚本
    { file: path.join(nodeDir, "npm"), viaNode: false, how: "node 同目录的 npm" },
    { file: "/usr/local/bin/npm", viaNode: false, how: "/usr/local/bin/npm" },
    { file: "/usr/bin/npm", viaNode: false, how: "/usr/bin/npm" },
    { file: "/www/server/nodejs/bin/npm", viaNode: false, how: "宝塔 nodejs 目录" },
  ];
  for (const c of candidates) {
    try {
      if (!existsSync(c.file)) continue;
      return c.viaNode
        ? { cmd: process.execPath, prefixArgs: [c.file], how: c.how }
        : { cmd: c.file, prefixArgs: [], how: c.how };
    } catch { /* 探测失败就试下一个 */ }
  }
  return { cmd: "npm", prefixArgs: [], how: "PATH（未能定位到绝对路径）" };
}

export function pickRemote(): string {
  return process.env.UPDATE_REMOTE || "origin";
}

export function pickBranch(): string {
  return process.env.UPDATE_BRANCH || "main";
}

export type RemoteEntry = { name: string; url: string };

/** Strip embedded credentials (`user:pass@host` form) from a git remote URL
 *  before we expose it to the admin UI. Some setups embed an access token
 *  directly in the URL — e.g. `https://name:token@gitee.com/...` — and we
 *  don't want that token rendered in plaintext on the update page or
 *  caught in audit logs. The remote in `.git/config` is unchanged; this
 *  is purely a display sanitizer. */
function sanitizeRemoteUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    return u.toString();
  } catch {
    // Non-URL remote (e.g. SSH git@host:repo.git form, or local path).
    // Defensive secondary scrub for the `proto://user:pass@` shape in
    // case our URL parser doesn't recognise the scheme.
    return raw.replace(/^([a-z][a-z0-9+\-.]*:\/\/)[^/@\s]+@/i, "$1");
  }
}

/** Enumerate configured git remotes via `git remote -v`. Output looks like
 *  `origin\thttps://github.com/...\t(fetch)` — we dedupe on name and keep
 *  only fetch URLs. URLs are credential-sanitized before return so the
 *  admin UI never displays embedded tokens. Used by the admin UI to
 *  populate the source selector (GitHub origin vs Gitee mirror, etc). */
export async function listRemotes(): Promise<RemoteEntry[]> {
  try {
    const out = (await run("git", ["remote", "-v"])).stdout.trim();
    const seen = new Map<string, string>();
    for (const line of out.split("\n")) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
      if (m) seen.set(m[1]!, sanitizeRemoteUrl(m[2]!));
    }
    return [...seen.entries()].map(([name, url]) => ({ name, url }));
  } catch {
    return [];
  }
}

// Default URLs for the maintained mirrors — admin UI uses these when
// the server doesn't yet have the corresponding remote configured and
// the user clicks "添加 GitHub / Gitee 镜像". Keep in sync with README.
//
// Both are checked-out parts of the same source tree; admins can pick
// whichever is faster from their network. Servers that install.sh from
// Gitee end up with `origin` pointing at Gitee, so adding the GitHub
// URL as a separate `github` remote is how they get the choice back.
const DEFAULT_GITEE_URL = "https://gitee.com/zhaorunsen/by-wave-calendar.git";
const DEFAULT_GITHUB_URL = "https://github.com/wuha-like-sleep/by-wave-calendar.git";

/** Add a new remote (idempotent: if the name already exists, set-url
 *  to the new value). Used by the admin UI's "添加 GitHub / Gitee 镜像"
 *  buttons so admins can switch between sources without SSH-ing in. */
export async function addRemote(name: string, url?: string): Promise<{ ok: boolean; url: string; error?: string }> {
  const target = url ||
    (name === "gitee" ? DEFAULT_GITEE_URL :
     name === "github" ? DEFAULT_GITHUB_URL : "");
  if (!target) return { ok: false, url: "", error: "未提供仓库 URL" };
  try {
    // Idempotent: if remote exists, just set-url. If not, add.
    const existing = await listRemotes();
    if (existing.some((r) => r.name === name)) {
      await run("git", ["remote", "set-url", name, target]);
    } else {
      await run("git", ["remote", "add", name, target]);
    }
    return { ok: true, url: target };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, url: target, error: msg };
  }
}

export async function checkForUpdates(remoteOverride?: string): Promise<UpdateStatus> {
  const remote = remoteOverride || pickRemote();
  const branch = pickBranch();
  await run("git", ["fetch", remote, branch]).catch((err) => {
    throw new Error(`git fetch 失败：${err.message}`);
  });

  const head = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  const headSubject = (await run("git", ["log", "-1", "--pretty=%s", "HEAD"])).stdout.trim();
  let remoteSha: string | null = null;
  try {
    remoteSha = (await run("git", ["rev-parse", `${remote}/${branch}`])).stdout.trim();
  } catch {
    remoteSha = null;
  }

  let behind = 0;
  let newCommits: { sha: string; subject: string; date: string }[] = [];
  if (remoteSha && remoteSha !== head) {
    try {
      const log = (await run("git", [
        "log",
        "--pretty=%h%x01%s%x01%cI",
        `HEAD..${remote}/${branch}`,
      ])).stdout;
      newCommits = log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, subject, date] = line.split("\x01");
          return { sha: sha || "", subject: subject || "", date: date || "" };
        });
      behind = newCommits.length;
    } catch {
      behind = 0;
    }
  }

  // Quick "is the working tree dirty?" probe
  const status = (await run("git", ["status", "--porcelain"])).stdout.trim();

  return {
    remote,
    branch,
    currentSha: head.slice(0, 12),
    currentSubject: headSubject,
    remoteSha: remoteSha ? remoteSha.slice(0, 12) : null,
    behind,
    newCommits,
    hasLocalChanges: status.length > 0,
  };
}

export type UpdateLog = { step: string; ok: boolean; output: string };
export type UpdateProgressEvent =
  | { type: "start"; step: string; index: number; total: number }
  | { type: "done"; step: string; index: number; total: number; ok: boolean; output: string }
  | { type: "final"; ok: boolean };

const STEPS = (npm: { cmd: string; prefixArgs: string[] }, remote: string, branch: string): { name: string; cmd: string; args: string[] }[] => [
  { name: "git fetch", cmd: "git", args: ["fetch", remote, branch] },
  { name: "git reset --hard", cmd: "git", args: ["reset", "--hard", `${remote}/${branch}`] },
  { name: "npm ci", cmd: npm.cmd, args: [...npm.prefixArgs, "ci", "--include=dev"] },
  { name: "npm run build", cmd: npm.cmd, args: [...npm.prefixArgs, "run", "build"] },
  { name: "db migrate", cmd: npm.cmd, args: [...npm.prefixArgs, "run", "db:migrate"] },
];

export async function* applyUpdateStream(remoteOverride?: string): AsyncGenerator<UpdateProgressEvent> {
  const npm = resolveNpm();
  const steps = STEPS(npm, remoteOverride || pickRemote(), pickBranch());
  const total = steps.length;
  let ok = true;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    yield { type: "start", step: s.name, index: i, total };
    try {
      const { stdout, stderr } = await run(s.cmd, s.args);
      yield {
        type: "done", step: s.name, index: i, total, ok: true,
        output: (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).slice(0, 8000),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "done", step: s.name, index: i, total, ok: false, output: msg.slice(0, 8000) };
      ok = false;
      break;
    }
  }
  yield { type: "final", ok };
}

export async function applyUpdate(remoteOverride?: string): Promise<{ logs: UpdateLog[]; ok: boolean }> {
  const logs: UpdateLog[] = [];
  let finalOk = true;
  for await (const ev of applyUpdateStream(remoteOverride)) {
    if (ev.type === "done") logs.push({ step: ev.step, ok: ev.ok, output: ev.output });
    if (ev.type === "final") finalOk = ev.ok;
  }
  return { logs, ok: finalOk };
}

// ============================================================================
// 离线 / 手动更新（上传已签名的 release tarball）
// ----------------------------------------------------------------------------
// 安全模型：上传更新包 = 在服务器上运行上传者提供的代码。因此「这个包确实由
// 持有私钥的维护者签发、且未被篡改」是唯一的硬安全边界。我们用 ed25519 分离
// 签名（detached signature）来证明这点：
//
//   - 维护者本机持有私钥（~/.bywave-update/update-ed25519-private.pem，永不外传）。
//   - 公钥随仓库发布（deploy/update-signing-pub.pem），服务器在模块加载时读入。
//   - release.sh 用私钥对 tarball 的「原始字节」签名 → 写 <tarball>.sig（base64）。
//   - 服务器收到上传的 tarball + sig 后，先验签：用公钥校验签名覆盖的就是收到的
//     这串字节。验签不过 → 直接拒绝，什么都不解压、不应用。
//
// 这套机制只防「篡改 / 伪造更新包」，不防「拥有私钥的人发坏包」——后者属于
// 维护者信任范围，超出本功能边界。
// ============================================================================

// 上传体积上限（路由层也会再挡一次；这里作为常量供路由复用）。
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB

// 公钥落点：项目根 deploy/update-signing-pub.pem。服务端(dev 与生产)都从项目根启动,
// 所以 CWD 是最可靠的锚点。编译后本模块在 dist/src/lib/ 下、tsx 直跑在 src/lib/ 下,
// 层级不同,故再叠加两种模块相对路径兜底,按顺序取第一个存在的。
const __dirname_self = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_KEY_CANDIDATES = [
  path.resolve(process.cwd(), "deploy", "update-signing-pub.pem"),
  path.resolve(__dirname_self, "..", "..", "..", "deploy", "update-signing-pub.pem"), // 编译后 dist/src/lib → 根
  path.resolve(__dirname_self, "..", "..", "deploy", "update-signing-pub.pem"),         // tsx 直跑 src/lib → 根
];

// 模块加载时读入公钥 PEM。读不到就置 null —— verifyUpdateSignature 会因此对所有
// 输入返回 false（fail-closed：没有可信公钥时，宁可拒绝一切更新，也不放行）。
const SIGNING_PUBLIC_KEY_PEM: string | null = (() => {
  for (const p of PUBLIC_KEY_CANDIDATES) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      // 试下一个候选路径
    }
  }
  console.error("[self_update] 未找到更新签名公钥 deploy/update-signing-pub.pem —— 手动更新将拒绝所有上传");
  return null;
})();

/**
 * ed25519 验签：用内嵌公钥校验 sigBase64 是否为 tarball 原始字节的有效签名。
 * 任意错误（公钥缺失、签名格式错、文件读不到、验签不过）一律返回 false。
 * 这是「上传更新」的安全闸门，调用方必须在解压/应用前先过这道。
 */
export async function verifyUpdateSignature(tarballPath: string, sigBase64: string): Promise<boolean> {
  try {
    if (!SIGNING_PUBLIC_KEY_PEM) return false;
    const sig = Buffer.from(String(sigBase64 || "").trim(), "base64");
    // ed25519 签名固定 64 字节；长度不对直接判伪，省得把垃圾喂给 verify。
    if (sig.length !== 64) return false;
    const data = await readFile(tarballPath);
    const key = createPublicKey(SIGNING_PUBLIC_KEY_PEM);
    // node:crypto 的 ed25519 走 verify(null, ...)（算法隐含在 key 类型里）。
    return cryptoVerify(null, data, key, sig);
  } catch {
    return false;
  }
}

export type UploadedUpdateProgressEvent = UpdateProgressEvent;

// 应用上传包时，只把这些已知路径从解压目录覆盖到项目根。绝不执行包里的脚本，
// 也不拷贝 deploy/ 之类含可执行内容的目录 —— 只搬运代码产物与依赖清单。
const APPLY_DIRS = ["dist", "src/views", "src/public", "drizzle"] as const;
const APPLY_FILES = [
  "package.json",
  "package-lock.json",
  // 三端 App 的更新清单。**必须走 APPLY_FILES 而不是 APPLY_DIRS** ——
  // 上面那段对非 dist 的目录会先 rm -rf 整个目标目录,把 apps/ 加进去
  // 会连站长自己放在那儿的别的东西一起删掉。
  //
  // 为什么要加:服务端的 /api/app/{android,desktop}/latest 读的就是这两个
  // 文件(android_release.ts / desktop_release.ts 的 COMMITTED_MANIFEST_PATH)。
  // 而发版 tarball 以前不含 apps/,所以用后台「系统更新」升级的站长永远
  // 拿不到随代码走的那份清单,只能手工往 data/ 里丢文件 —— 不丢的话
  // 他的 /download 页面会一直对所有访客显示旧版本号和旧下载链接。
  //
  // ⚠️ 只加 scripts/release.sh 那一侧是不够的:包里有了文件,而这张白名单
  // 不认它,上传更新会验签、解压、体检、npm ci、迁移**五步全绿**,而清单
  // 静默落不了地。判据必须落在「应用完之后服务器上那份清单的 versionCode」,
  // 不能落在「tarball 里有没有这个文件」。
  "apps/android/releases/latest.json",
  "apps/desktop/releases/latest.json",
] as const;

/** tar 条目路径是否安全：拒绝绝对路径、`..` 逃逸、以及 Windows 盘符。 */
function isUnsafeTarEntry(entry: string): boolean {
  const e = entry.trim();
  if (!e) return false; // 空行忽略
  if (e.startsWith("/") || e.startsWith("\\")) return true; // 绝对路径
  if (/^[a-zA-Z]:/.test(e)) return true; // 盘符 C:\...
  // 任意一段是 `..` 即视为逃逸（覆盖 ../x、x/../y、x/.. 等形态）。
  const parts = e.split(/[/\\]/);
  if (parts.some((p) => p === "..")) return true;
  return false;
}

/**
 * 应用一个「已上传的、已签名的」更新包，按步骤流式产出进度事件（结构对齐
 * applyUpdateStream）。步骤：
 *   1) verify signature —— 不过即停，绝不解压/应用（安全闸门）
 *   2) extract          —— 解压到临时目录，防 zip-slip + 结构体检
 *   3) apply files      —— 只覆盖已知目录/文件（先删旧 dist，避免残留）
 *   4) npm ci           —— 装新版本的生产依赖
 *   5) db migrate       —— 跑迁移
 * 重启由调用方单独触发（restartProcess），与 git 流程一致。
 */
export async function* applyUploadedUpdate(
  tarballPath: string,
  sigBase64: string,
): AsyncGenerator<UploadedUpdateProgressEvent> {
  const npm = resolveNpm();
  const total = 5;
  let staging: string | null = null;
  let stagedRoot: string | null = null;
  let ok = true;

  const fail = (step: string, index: number, output: string): UploadedUpdateProgressEvent => {
    ok = false;
    return { type: "done", step, index, total, ok: false, output: output.slice(0, 8000) };
  };

  try {
    // ---- 1) verify signature（安全闸门）----
    yield { type: "start", step: "verify signature", index: 0, total };
    const sigOk = await verifyUpdateSignature(tarballPath, sigBase64);
    if (!sigOk) {
      yield fail(
        "verify signature",
        0,
        "签名校验失败：上传文件不是由本仓库私钥签发的更新包，或已被篡改 / 签名不匹配。已拒绝，未应用任何改动。",
      );
      yield { type: "final", ok: false };
      return;
    }
    yield { type: "done", step: "verify signature", index: 0, total, ok: true, output: "✓ ed25519 签名校验通过（包完整且来源可信）" };

    // ---- 2) extract（防 zip-slip + 结构体检）----
    yield { type: "start", step: "extract", index: 1, total };
    try {
      staging = await mkdtemp(path.join(tmpdir(), "bwc-update-"));
      // 先列出条目做路径安全校验，再真正解压。
      const list = (await run("tar", ["-tzf", tarballPath])).stdout;
      const entries = list.split("\n").map((s) => s.trim()).filter(Boolean);
      if (entries.length === 0) throw new Error("tarball 内没有任何条目");
      const bad = entries.find(isUnsafeTarEntry);
      if (bad) throw new Error(`检测到不安全的路径条目（可能是 zip-slip 攻击）：${bad}`);

      // 忽略 macOS 打包时可能夹带的元数据：AppleDouble `._*` 与 `.DS_Store`。
      // 它们无害（apply 只拷已知目录，不会带上它们），但会让「顶层单目录」体检
      // 误判——在 iCloud/带扩展属性的目录上用 tar 打包极易出现 `._<name>`。
      const isMacMeta = (e: string): boolean => {
        const base = e.split("/").pop() ?? "";
        return base === ".DS_Store" || base.startsWith("._");
      };
      const meaningful = entries.filter((e) => !isMacMeta(e));

      // 顶层目录应为 by-wave-calendar-v<version>/ —— 校验只有一个顶层目录且符合命名。
      const topLevel = new Set(meaningful.map((e) => e.split("/")[0]).filter(Boolean));
      if (topLevel.size !== 1) {
        throw new Error(`tarball 顶层应只有一个目录，实际有 ${topLevel.size} 个：${[...topLevel].join(", ")}`);
      }
      const rootName = [...topLevel][0]!;
      if (!/^by-wave-calendar-v.+$/.test(rootName)) {
        throw new Error(`tarball 顶层目录名不符合 by-wave-calendar-v* 规范：${rootName}`);
      }

      await run("tar", ["-xzf", tarballPath, "-C", staging]);

      // 解压后再次确认：staged 根目录、package.json（可解析 version）、dist/ 都在。
      stagedRoot = path.join(staging, rootName);
      // 防御：rootName 已校验不含 ..，stagedRoot 必须仍在 staging 内。
      if (!path.resolve(stagedRoot).startsWith(path.resolve(staging) + path.sep)) {
        throw new Error("解压目标逃逸出临时目录，已中止");
      }
      const pkgPath = path.join(stagedRoot, "package.json");
      let stagedVersion = "";
      try {
        const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
        stagedVersion = String(pkg.version || "");
      } catch {
        throw new Error("更新包缺少可解析的 package.json，已中止");
      }
      if (!stagedVersion) throw new Error("更新包 package.json 没有 version 字段，已中止");
      const distStat = await stat(path.join(stagedRoot, "dist")).catch(() => null);
      if (!distStat || !distStat.isDirectory()) {
        throw new Error("更新包缺少 dist/ 目录（不是有效的构建产物），已中止");
      }
      // stagedRoot 已赋值，供下一步 apply files 使用。
      yield { type: "done", step: "extract", index: 1, total, ok: true, output: `✓ 已解压并体检通过（版本 v${stagedVersion}，${entries.length} 个条目）` };
    } catch (err) {
      yield fail("extract", 1, err instanceof Error ? err.message : String(err));
      yield { type: "final", ok: false };
      return;
    }

    // ---- 3) apply files（尽量晚做，verify+extract+体检全过之后才动项目根）----
    yield { type: "start", step: "apply files", index: 2, total };
    try {
      if (!stagedRoot) throw new Error("内部错误：staged 根目录缺失");
      const applied: string[] = [];
      // 先删旧 dist，避免上一个版本删掉的文件残留导致行为混乱。
      await rm(path.join(CWD, "dist"), { recursive: true, force: true });
      for (const rel of APPLY_DIRS) {
        const from = path.join(stagedRoot, rel);
        const to = path.join(CWD, rel);
        const exists = await stat(from).catch(() => null);
        if (!exists) continue; // 包里没有该目录就跳过（如某些包不带 drizzle）
        if (rel !== "dist") {
          // 覆盖式拷贝目录：先确保父目录存在。dist 上面已 rm，重新建。
          await rm(to, { recursive: true, force: true });
        }
        await mkdir(path.dirname(to), { recursive: true });
        await cp(from, to, { recursive: true });
        applied.push(rel + "/");
      }
      for (const rel of APPLY_FILES) {
        const from = path.join(stagedRoot, rel);
        const to = path.join(CWD, rel);
        const exists = await stat(from).catch(() => null);
        if (!exists) continue;
        // copyFile 不会自己建父目录。package.json 那两个的父目录就是项目根、
        // 一定存在,但 apps/*/releases/ 在 tarball 模式部署上压根不存在 ——
        // 少这一行的话它们会静默失败(被上面那个 try 吞成整步报错)。
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(from, to);
        applied.push(rel);
      }
      yield { type: "done", step: "apply files", index: 2, total, ok: true, output: `✓ 已覆盖：${applied.join("、")}` };
    } catch (err) {
      yield fail("apply files", 2, err instanceof Error ? err.message : String(err));
      yield { type: "final", ok: false };
      return;
    }

    // ---- 4) npm ci（生产依赖）----
    yield { type: "start", step: "npm ci", index: 3, total };
    try {
      const { stdout, stderr } = await run(npm.cmd, [...npm.prefixArgs, "ci", "--omit=dev"]);
      yield { type: "done", step: "npm ci", index: 3, total, ok: true,
              output: `[npm 来源] ${npm.how}\n` + (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).slice(0, 8000) };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // ENOENT 的原文只有一句 "spawn npm ENOENT"，看不出该怎么办。
      // 这一步失败时新版本文件**已经覆盖上去了**，系统停在「代码新、依赖旧」
      // 的半更新状态 —— 必须把补救办法直接写给管理员。
      const hint = /ENOENT/.test(raw)
        ? `\n\n找不到 npm（尝试的来源：${npm.how}）。\n` +
          `新版本的文件已经解压覆盖，但依赖没装上，服务此刻可能起不来。\n\n` +
          `在服务器上执行下面两条即可补完：\n` +
          `  cd ${CWD} && $(command -v npm || echo /usr/local/bin/npm) ci --omit=dev\n` +
          `  pm2 restart ${process.env.PM2_PROCESS_NAME || process.env.name || "by-wave-calendar"}\n\n` +
          `要根治：用 \`which npm\` 查出绝对路径，写进 .env 的 NPM_BIN=，再重启服务。`
        : "";
      yield fail("npm ci", 3, raw + hint);
      yield { type: "final", ok: false };
      return;
    }

    // ---- 5) db migrate ----
    // 必须用编译好的 dist/scripts/migrate.js（和 install.sh 生产迁移一致）。
    // 上一步 `npm ci --omit=dev` 已把 tsx 等 dev 依赖删掉,所以绝不能用
    // `npm run db:migrate`(= tsx scripts/migrate.ts) —— 那会因缺 tsx 而报错。
    yield { type: "start", step: "db migrate", index: 4, total };
    try {
      const { stdout, stderr } = await run("node", ["dist/scripts/migrate.js"]);
      yield { type: "done", step: "db migrate", index: 4, total, ok: true, output: (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).slice(0, 8000) };
    } catch (err) {
      yield fail("db migrate", 4, err instanceof Error ? err.message : String(err));
      yield { type: "final", ok: false };
      return;
    }

    yield { type: "final", ok };
  } finally {
    // 清理临时解压目录。tarball 本身由路由层清理。
    if (staging) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function restartProcess(): Promise<{ ok: boolean; output: string }> {
  // 进程名优先用 PM2 注入的 `name`(它就是 pm2 list 里显示的那个),
  // 而不是写死 "by-wave-calendar" —— 装的时候用了别的名字(或者
  // ecosystem 文件里改过),写死的名字会让 `pm2 restart` 直接失败,
  // 后台的「重启服务」按钮就成了摆设。
  const procName = process.env.PM2_PROCESS_NAME || process.env.name || "by-wave-calendar";
  try {
    const { stdout, stderr } = await run("pm2", ["restart", procName]);
    return { ok: true, output: (stdout + (stderr ? "\n" + stderr : "")).slice(0, 4000) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 兜底:只要我们本来就跑在 PM2 下(pm_id 由 PM2 注入),自己退出
    // 就够了 —— 守护进程会立刻用全新环境把我们拉起来,这正是改完
    // .env 需要的效果。pm2 CLI 不在 PATH 里(常见于宝塔/容器)时全靠这条。
    if (process.env.pm_id !== undefined) {
      setTimeout(() => process.exit(0), 300);
      return { ok: true, output: `pm2 CLI 不可用(${msg.slice(0, 200)}),已改为自退出让守护进程重启` };
    }
    return { ok: false, output: msg.slice(0, 4000) };
  }
}
