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

export async function checkForUpdates(): Promise<UpdateStatus> {
  const remote = pickRemote();
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

export async function applyUpdate(): Promise<{ logs: UpdateLog[]; ok: boolean }> {
  const remote = pickRemote();
  const branch = pickBranch();
  const logs: UpdateLog[] = [];

  const step = async (name: string, cmd: string, args: string[]): Promise<boolean> => {
    try {
      const { stdout, stderr } = await run(cmd, args);
      logs.push({ step: name, ok: true, output: (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).slice(0, 8000) });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logs.push({ step: name, ok: false, output: msg.slice(0, 8000) });
      return false;
    }
  };

  if (!(await step("git fetch", "git", ["fetch", remote, branch]))) return { logs, ok: false };
  if (!(await step("git reset --hard", "git", ["reset", "--hard", `${remote}/${branch}`]))) return { logs, ok: false };

  // npm ci with devDeps so tsc + tailwind are available
  const npmBin = process.env.NPM_BIN || "npm";
  if (!(await step("npm ci", npmBin, ["ci", "--include=dev"]))) return { logs, ok: false };
  if (!(await step("npm run build", npmBin, ["run", "build"]))) return { logs, ok: false };
  if (!(await step("db migrate", npmBin, ["run", "db:migrate"]))) return { logs, ok: false };

  return { logs, ok: true };
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
