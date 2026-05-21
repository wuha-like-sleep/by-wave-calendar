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

export async function* applyUpdateStream(): AsyncGenerator<UpdateProgressEvent> {
  const npmBin = process.env.NPM_BIN || "npm";
  const steps = STEPS(npmBin, pickRemote(), pickBranch());
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

export async function applyUpdate(): Promise<{ logs: UpdateLog[]; ok: boolean }> {
  const logs: UpdateLog[] = [];
  let finalOk = true;
  for await (const ev of applyUpdateStream()) {
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
