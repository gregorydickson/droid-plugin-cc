import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv } from "./fake-droid-fixture.mjs";
import { installWorkerDroid } from "./worker-droid-fixture.mjs";
import { readStoredJob } from "../plugins/droid/scripts/lib/job-control.mjs";
import { writeJobFile } from "../plugins/droid/scripts/lib/state.mjs";
import { resolveRuntimeOptions } from "../plugins/droid/scripts/lib/runtime-options.mjs";

const script = fileURLToPath(new URL("../plugins/droid/scripts/droid-companion.mjs", import.meta.url));
const THREAD_FIELDS = ["cwd"];
const JOB_FIELDS = ["write", "worktree", "lockCmd", "unlockCmd", "outputSchema", "pauseAndAsk", "effectiveProfile", "activeServers", "developerInstructions", "config", "sandbox"];
const pick = (object, fields) => Object.fromEntries(fields.map(field => [field, object[field] ?? null]));

function git(cwd, ...args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function linkedWorktree() {
  const main = makeTempDir(); initGitRepo(main);
  fs.writeFileSync(path.join(main, "README.md"), "hello\n");
  git(main, "add", "README.md"); git(main, "commit", "-m", "init");
  const linked = makeTempDir("droid-plugin-linked-");
  git(main, "worktree", "add", "-b", "slice", linked);
  return { main: fs.realpathSync(main), linked: fs.realpathSync(linked), gitDir: fs.realpathSync(git(linked, "rev-parse", "--absolute-git-dir")) };
}

function setup(brief = "Count rows") {
  const { main, linked, gitDir } = linkedWorktree();
  const bin = makeTempDir(); installWorkerDroid(bin);
  const files = makeTempDir();
  const env = { ...buildEnv(bin), DROID_HOME: makeTempDir(), DROID_COMPANION_SESSION_ID: "resume-tests" };
  const file = (name, content) => { const target = path.join(files, name); fs.writeFileSync(target, content); return target; };
  const paths = {
    schema: file("schema.json", JSON.stringify({ type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false })),
    otherSchema: file("other-schema.json", JSON.stringify({ type: "object", required: ["count"], properties: { count: { type: "number" } } })),
    mcp: file("no-mcp.json", JSON.stringify({ mcp_servers: {} })),
    brief: file("slice.md", brief),
    autonomy: file("AUTONOMY.md", "Never push."),
    plan: file("plan.md", "plan-sentinel"),
    lockLog: path.join(files, "lock.log")
  };
  const cli = (...args) => {
    const result = run(process.execPath, [script, ...args, "--json"], { cwd: main, env });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  const fake = () => JSON.parse(fs.readFileSync(path.join(bin, "fake-droid-state.json"), "utf8"));
  const lockEvents = () => fs.readFileSync(paths.lockLog, "utf8").trim().split("\n");
  const start = (...extra) => cli("task", "--write", "--worktree", linked,
    "--lock-cmd", `echo lock >> '${paths.lockLog}'`, "--unlock-cmd", `echo unlock >> '${paths.lockLog}'`,
     "--name", "slice-one", "--pause-and-ask",
    "--brief", paths.brief, "--instructions", paths.autonomy, "--preread", paths.plan,
    "--output-schema", paths.schema, ...extra, "Start the slice");
  return { main, linked, gitDir, env, files, paths, cli, fake, lockEvents, start };
}

function assertInherited(ctx, original, resumed) {
  const requests = ctx.fake().threadRequests;
  const started = requests.find(entry => entry.method === "start" && entry.threadId === original.threadId);
  const continued = requests.at(-1);
  assert.equal(continued.method, "resume");
  assert.equal(continued.threadId, original.threadId);
  assert.equal(continued.args[continued.args.indexOf("--auto") + 1], "medium");
  assert.deepEqual(pick(continued, THREAD_FIELDS), pick(started, THREAD_FIELDS));
  assert.deepEqual(pick(readStoredJob(ctx.linked, resumed.jobId), JOB_FIELDS), pick(readStoredJob(ctx.linked, original.jobId), JOB_FIELDS));
  assert.deepEqual(ctx.lockEvents(), ["lock", "unlock", "lock", "unlock"]);
}

test("task --resume-last inherits the original job's write, worktree, lock, profile, MCP, schema, and instructions", () => {
  const ctx = setup();
  const original = ctx.start();
  assert.equal(original.status, "completed");
  const resumed = ctx.cli("task", "--resume-last", "--worktree", ctx.linked, "Fix round");
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.threadId, original.threadId);
  assert.equal(resumed.schemaValid, true);
  assertInherited(ctx, original, resumed);
});

test("sessions resume inherits the original job's options", () => {
  const ctx = setup();
  const original = ctx.start();
  const resumed = ctx.cli("sessions", "resume", "slice-one", "Next slice", "--background");
  ctx.cli("status", resumed.jobId, "--wait");
  assert.equal(ctx.cli("result", resumed.jobId).status, "completed");
  assertInherited(ctx, original, resumed);
});

test("answer keeps the paused job's id, thread, write access, lock, and result-file pattern", () => {
  const ctx = setup("NEED_ANSWER");
  const pattern = path.join(ctx.files, "results", "{jobId}.json");
  const paused = ctx.start("--result-file", pattern);
  assert.equal(paused.status, "awaiting-answer");
  const published = path.join(ctx.files, "results", `${paused.jobId}.json`);
  assert.equal(JSON.parse(fs.readFileSync(published, "utf8")).status, "awaiting-answer");
  const answered = ctx.cli("answer", paused.jobId, "yes");
  assert.equal(answered.status, "completed");
  assert.equal(answered.jobId, paused.jobId);
  const requests = ctx.fake().threadRequests;
  assert.deepEqual(pick(requests.at(-1), THREAD_FIELDS), pick(requests.find(entry => entry.method === "start"), THREAD_FIELDS));
  assert.ok(requests.at(-1).args.includes("medium"));
  assert.match(ctx.fake().lastTurnStart.prompt, /Never push\.[\s\S]*JSON stop report/);
  assert.deepEqual(ctx.lockEvents(), ["lock", "unlock", "lock", "unlock"]);
  assert.equal(JSON.parse(fs.readFileSync(published, "utf8")).status, "completed");
});

test("a resume never re-sends the previous slice's brief or preread", () => {
  const ctx = setup("brief-sentinel");
  ctx.start();
  ctx.cli("sessions", "resume", "slice-one", "Next slice");
  const prompt = ctx.fake().lastTurnStart.prompt;
  assert.match(prompt, /\nNext slice\n/);
  assert.doesNotMatch(prompt, /brief-sentinel|plan-sentinel/);
});

test("resume flags override the inherited options", () => {
  const ctx = setup();
  const original = ctx.start();
  const nextBrief = path.join(ctx.files, "next.md");
  fs.writeFileSync(nextBrief, "next-brief-sentinel");
  const resumed = ctx.cli("sessions", "resume", "slice-one", "--brief", nextBrief, "--output-schema", ctx.paths.otherSchema, "--model", "override-model", "Next slice");
  assert.match(ctx.fake().lastTurnStart.prompt, /next-brief-sentinel/);
  const stored = readStoredJob(ctx.linked, resumed.jobId);
  assert.deepEqual(stored.outputSchema, JSON.parse(fs.readFileSync(ctx.paths.otherSchema, "utf8")));
  assert.equal(stored.model, "override-model");
  assert.equal(stored.lockCmd, readStoredJob(ctx.linked, original.jobId).lockCmd);
  assert.ok(ctx.fake().threadRequests.at(-1).args.includes("medium"));
});

test("resume keeps the previous slice's result file unless it is the same job", () => {
  const ctx = setup();
  const first = path.join(ctx.files, "first.json");
  const original = ctx.start("--result-file", first);
  assert.equal(JSON.parse(fs.readFileSync(first, "utf8")).jobId, original.jobId);
  const silent = ctx.cli("sessions", "resume", "slice-one", "Second slice");
  assert.equal(JSON.parse(fs.readFileSync(first, "utf8")).jobId, original.jobId);
  assert.equal(readStoredJob(ctx.linked, silent.jobId).resultFile, null);
  const second = path.join(ctx.files, "second.json");
  const explicit = ctx.cli("sessions", "resume", "slice-one", "--result-file", second, "Third slice");
  assert.equal(JSON.parse(fs.readFileSync(second, "utf8")).jobId, explicit.jobId);
  assert.equal(JSON.parse(fs.readFileSync(first, "utf8")).jobId, original.jobId);
});

test("a {jobId} result-file pattern is inherited and expanded per job", () => {
  const ctx = setup();
  const pattern = path.join(ctx.files, "results", "{jobId}.json");
  const original = ctx.start("--result-file", pattern);
  const resumed = ctx.cli("sessions", "resume", "slice-one", "Next slice");
  for (const job of [original, resumed]) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.files, "results", `${job.jobId}.json`), "utf8")).jobId, job.jobId);
  }
  assert.equal(fs.existsSync(pattern), false);
  assert.equal(ctx.cli("status", resumed.jobId).job.resultFile, path.join(ctx.files, "results", `${resumed.jobId}.json`));
});

test("answer publishes to the paused job's own result file", () => {
  const ctx = setup("NEED_ANSWER");
  const resultFile = path.join(ctx.files, "paused.json");
  const paused = ctx.start("--result-file", resultFile);
  assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).status, "awaiting-answer");
  ctx.cli("answer", paused.jobId, "yes");
  const published = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  assert.equal(published.jobId, paused.jobId);
  assert.equal(published.status, "completed");
});

test("a resume refuses to move the session to another worktree or rename it", () => {
  const ctx = setup();
  ctx.start();
  for (const [flags, message] of [[["--worktree", ctx.main], /keeps its original worktree/], [["--name", "renamed"], /--name cannot change on resume/]]) {
    const result = run(process.execPath, [script, "sessions", "resume", "slice-one", ...flags, "--json", "Next"], { cwd: ctx.main, env: ctx.env });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
});

test("a session recorded before worker arguments were kept resumes from its stored request", () => {
  const ctx = setup();
  const first = path.join(ctx.files, "legacy.json");
  const original = ctx.start("--result-file", first);
  const stored = readStoredJob(ctx.linked, original.jobId);
  delete stored.request.workerArgs;
  writeJobFile(ctx.linked, original.jobId, stored);
  const rejected = run(process.execPath, [script, "sessions", "resume", "slice-one", "--model", "other", "--json", "Next"], { cwd: ctx.main, env: ctx.env });
  assert.match(rejected.stderr, /predates resume overrides/);
  const resumed = ctx.cli("sessions", "resume", "slice-one", "Next slice");
  assert.equal(resumed.status, "completed");
  assert.ok(ctx.fake().threadRequests.at(-1).args.includes("medium"));
  assert.equal(readStoredJob(ctx.linked, resumed.jobId).resultFile, null);
  assert.equal(JSON.parse(fs.readFileSync(first, "utf8")).jobId, original.jobId);
});
