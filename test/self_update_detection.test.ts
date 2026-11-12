import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkForUpdates } from "../src/lib/self_update.js";
const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "bywave-update-test-")); dirs.push(root);
  const remote = path.join(root, "remote.git"), source = path.join(root, "source"), installed = path.join(root, "installed");
  const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
  await git(root, "init", "--bare", remote);
  await git(root, "init", "-b", "main", source);
  await git(source, "config", "user.name", "Test"); await git(source, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(source, "version"), "1"); await git(source, "add", "."); await git(source, "commit", "-m", "initial");
  await git(source, "remote", "add", "origin", remote); await git(source, "push", "origin", "main");
  await git(root, "clone", "--branch", "main", remote, installed);
  vi.stubEnv("UPDATE_BRANCH", "main");
  return { git, root, remote, source, installed };
}
describe("admin update detection", () => {
  it("finds an update even when remote.fetch no longer maps the branch", async () => {
    const { git, source, installed } = await repository();
    await git(installed, "config", "--unset-all", "remote.origin.fetch");
    const before = await git(installed, "rev-parse", "origin/main");
    await writeFile(path.join(source, "version"), "2"); await git(source, "commit", "-am", "new version"); await git(source, "push", "origin", "main");
    // The old fetch command succeeds but leaves origin/main at the old commit.
    await git(installed, "fetch", "origin", "main"); expect(await git(installed, "rev-parse", "origin/main")).toBe(before);
    const result = await checkForUpdates("origin", installed);
    expect(result.behind).toBe(1); expect(result.newCommits[0]?.subject).toBe("new version");
    expect(result.remoteSha).toBe((await git(source, "rev-parse", "HEAD")).slice(0, 12));
    expect(result.currentSha).toBe(before.slice(0, 12));
  });
  it("reports up to date only after a successful fetch and comparison", async () => {
    const { installed } = await repository(); const result = await checkForUpdates("origin", installed);
    expect(result.behind).toBe(0); expect(result.remoteSha).toBe(result.currentSha);
  });
  it("surfaces missing remote branches instead of claiming there are no updates", async () => {
    const { installed } = await repository(); vi.stubEnv("UPDATE_BRANCH", "missing");
    await expect(checkForUpdates("origin", installed)).rejects.toThrow();
  });
});
