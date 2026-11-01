import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { writeJobFile, upsertJob, listJobsAcrossWorktrees } from "../plugins/droid/scripts/lib/state.mjs";

const script = fileURLToPath(new URL("../plugins/droid/scripts/droid-companion.mjs", import.meta.url));

test("status wait resolves a linked-worktree name once and polls that job until completion", async () => {
  const cwd = makeTempDir(), linked = makeTempDir(), bin = makeTempDir();
  initGitRepo(cwd);
  assert.equal(run("git", ["commit", "--allow-empty", "-m", "initial"], { cwd }).status, 0);
  assert.equal(run("git", ["worktree", "add", "-b", "linked", linked], { cwd }).status, 0);
  const job = { id: "task-selected", name: "linked-job", workspaceRoot: linked, status: "running", pid: process.pid, createdAt: new Date().toISOString() };
  writeJobFile(linked, job.id, job); upsertJob(linked, job);
  const callsFile = path.join(bin, "calls.jsonl");
  const observer = path.join(bin, "observe-git.mjs");
  fs.writeFileSync(observer, `import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; const original = cp.spawnSync; cp.spawnSync = function(command, args, options) { if (command === 'git' && args[0] === 'worktree') fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args)+'\\n'); return original.call(this, command, args, options); }; syncBuiltinESMExports();`);
  const child = spawn(process.execPath, ["--import", observer, script, "status", "linked-job", "--wait", "--poll-interval-ms", "100", "--timeout-ms", "10000", "--json"], { cwd, env: process.env });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  // Wait until target resolution has actually run before changing the selected record.
  const finish = (async () => {
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(callsFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(callsFile), "CLI did not resolve worktrees");
    await new Promise(resolve => setTimeout(resolve, 350));
    const completed = { ...job, status: "completed", summary: "selected job finished" };
    writeJobFile(linked, job.id, completed); upsertJob(linked, completed);
  })();
  const code = await new Promise(resolve => child.on("close", resolve));
  await finish;
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.waitTimedOut, false);
  assert.equal(fs.realpathSync(result.workspaceRoot), fs.realpathSync(linked));
  assert.equal(result.job.id, job.id);
  assert.equal(result.job.summary, "selected job finished");
  assert.deepEqual(fs.readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse), [["worktree", "list", "--porcelain", "-z"]]);
});

function findFixture() {
  const cwd = makeTempDir(), linked = makeTempDir();
  initGitRepo(cwd);
  assert.equal(run("git", ["commit", "--allow-empty", "-m", "initial"], { cwd }).status, 0);
  assert.equal(run("git", ["worktree", "add", "-b", "sibling", linked], { cwd }).status, 0);
  const store = (root, job) => { const full = { status: "completed", workspaceRoot: root, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...job }; writeJobFile(root, full.id, full); upsertJob(root, full); };
  const cli = (...args) => run("node", [script, ...args], { cwd, env: process.env });
  return { cwd, linked, store, cli };
}

const FIND_FIELDS = [
  { field: "id", target: { id: "task-zq9alpha" }, text: "ZQ9ALPHA" },
  { field: "name", target: { id: "t-name", name: "quokka-worker" }, text: "QUOKKA" },
  { field: "title", target: { id: "t-title", title: "Rewrite the Flux Capacitor" }, text: "flux capac" },
  { field: "jobTitle", target: { id: "t-jtitle", jobTitle: "Calibrate Gizmo" }, text: "gizmo" },
  { field: "threadId", target: { id: "t-thread", threadId: "sess-9f3c-unique" }, text: "9F3C-UNIQ" },
  { field: "a job in a sibling worktree", target: { id: "t-sibling", name: "sibling-only" }, text: "sibling-only", sibling: true }
];

for (const { field, target, text, sibling } of FIND_FIELDS) {
  test(`sessions find matches on ${field}, case-insensitively, and excludes a decoy`, () => {
    const { cwd, linked, store, cli } = findFixture();
    store(sibling ? linked : cwd, target);
    store(cwd, { id: "decoy-job", name: "decoy", title: "unrelated", threadId: "other-thread" });
    const found = JSON.parse(cli("sessions", "find", text, "--json").stdout).map(job => job.id);
    assert.ok(found.includes(target.id));
    assert.ok(!found.includes("decoy-job"));
  });
}

test("sessions find returns newest first, one text line per match, and never mutates records", () => {
  const { cwd, linked, store, cli } = findFixture();
  store(linked, { id: "newer-hit", name: "hit-new", updatedAt: "2026-02-01T00:00:00.000Z" });
  store(cwd, { id: "orphan-hit", name: "hit-orphan", status: "running", pid: 2147483646, updatedAt: "2025-12-01T00:00:00.000Z" });
  store(cwd, { id: "older-hit", name: "hit-old", updatedAt: "2026-01-01T00:00:00.000Z" });
  const before = JSON.stringify(listJobsAcrossWorktrees(cwd));
  assert.deepEqual(JSON.parse(cli("sessions", "find", "hit", "--json").stdout).map(job => job.id), ["newer-hit", "older-hit", "orphan-hit"]);
  const lines = cli("sessions", "find", "hit").stdout.trim().split("\n");
  assert.deepEqual(lines.map(line => line.split(" ")[0]), ["hit-new", "hit-old", "hit-orphan"]);
  assert.equal(JSON.stringify(listJobsAcrossWorktrees(cwd)), before);
});

test("sessions find with no match prints nothing and exits 0; --json prints an empty array", () => {
  const { cwd, store, cli } = findFixture();
  store(cwd, { id: "some-job", name: "present" });
  const plain = cli("sessions", "find", "nothing-matches-this");
  assert.equal(plain.status, 0);
  assert.equal(plain.stdout, "");
  const json = cli("sessions", "find", "nothing-matches-this", "--json");
  assert.equal(json.status, 0);
  assert.deepEqual(JSON.parse(json.stdout), []);
});

test("sessions find without text and unknown sessions actions fail with their exact messages", () => {
  const { cwd, store, cli } = findFixture();
  store(cwd, { id: "some-ref", name: "some-ref" });
  const empty = cli("sessions", "find");
  assert.equal(empty.status, 1);
  assert.equal(empty.stderr.trim(), "Provide text to find.");
  const unknown = cli("sessions", "bogus", "some-ref");
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stderr.trim(), "Use sessions list, find, stop, or resume.");
});
