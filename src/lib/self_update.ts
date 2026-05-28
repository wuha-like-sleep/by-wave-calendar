import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

// Default URL for the maintained Gitee mirror — admin UI uses this when
// the server doesn't yet have a `gitee` remote configured and the user
// clicks "添加 Gitee 镜像". Keep in sync with README's Gitee link.
const DEFAULT_GITEE_URL = "https://gitee.com/zhaorunsen/by-wave-calendar.git";

/** Add a new remote (idempotent: if the name already exists, succeeds
 *  silently). Used by the admin UI's "添加 Gitee 镜像" button so admins
 *  can switch between GitHub + Gitee without SSH-ing in. */
export async function addRemote(name: string, url?: string): Promise<{ ok: boolean; url: string; error?: string }> {
  const target = url || (name === "gitee" ? DEFAULT_GITEE_URL : "");
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

const STEPS = (npmBin: string, remote: string, branch: string): { name: string; cmd: string; args: string[] }[] => [
  { name: "git fetch", cmd: "git", args: ["fetch", remote, branch] },
  { name: "git reset --hard", cmd: "git", args: ["reset", "--hard", `${remote}/${branch}`] },
  { name: "npm ci", cmd: npmBin, args: ["ci", "--include=dev"] },
  { name: "npm run build", cmd: npmBin, args: ["run", "build"] },
  { name: "db migrate", cmd: npmBin, args: ["run", "db:migrate"] },
];

export async function* applyUpdateStream(remoteOverride?: string): AsyncGenerator<UpdateProgressEvent> {
  const npmBin = process.env.NPM_BIN || "npm";
  const steps = STEPS(npmBin, remoteOverride || pickRemote(), pickBranch());
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

export async function restartProcess(): Promise<{ ok: boolean; output: string }> {
  // Try pm2 first; fall back to systemd if PM_PROCESS isn't set.
  const procName = process.env.PM2_PROCESS_NAME || "by-wave-calendar";
  try {
    const { stdout, stderr } = await run("pm2", ["restart", procName]);
    return { ok: true, output: (stdout + (stderr ? "\n" + stderr : "")).slice(0, 4000) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: msg.slice(0, 4000) };
  }
}
