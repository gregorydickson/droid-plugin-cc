import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, run, smokeEnv, SMOKE_MODEL } from "./helpers.mjs";
import { buildEnv } from "./fake-droid-fixture.mjs";
import { installWorkerDroid } from "./worker-droid-fixture.mjs";
import { buildDroidExecArgs, DROID_FEATURE_FLOOR } from "../plugins/droid/scripts/lib/droid.mjs";
import { listJobs, resolveJobFile, upsertJob, writeJobFile } from "../plugins/droid/scripts/lib/state.mjs";

const script = fileURLToPath(new URL("../plugins/droid/scripts/droid-companion.mjs", import.meta.url));
const RUNNING_MESSAGE = "Session is still running. Wait for completion or cancel before resuming.";
const NO_THREAD_MESSAGE = "Session has no resumable thread.";
const flagValue = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const TERMINAL = ["completed", "failed", "cancelled", "orphaned"];
const alive = pid => { if (!Number.isInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function setup(extraEnv = {}) {
  const root = fs.realpathSync(makeTempDir()); initGitRepo(root);
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  run("git", ["add", "."], { cwd: root }); run("git", ["commit", "-m", "init"], { cwd: root });
  const bin = makeTempDir(); installWorkerDroid(bin);
  const env = { ...buildEnv(bin), DROID_HOME: makeTempDir(), DROID_COMPANION_SESSION_ID: "fork-tests", ...extraEnv };
  const schema = path.join(root, "schema.json");
  fs.writeFileSync(schema, JSON.stringify({ type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false }));
  const raw = (...args) => run(process.execPath, [script, ...args, "--json"], { cwd: root, env });
  const cli = (...args) => {
    const result = raw(...args);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  const requests = () => JSON.parse(fs.readFileSync(path.join(bin, "fake-droid-state.json"), "utf8")).threadRequests;
  const stored = id => JSON.parse(fs.readFileSync(resolveJobFile(root, id), "utf8"));
  // A finished job's detached watchdog still writes its terminal delivery after the CLI returns; snapshot only once it has exited.
  const record = id => {
    const deadline = Date.now() + 15000;
    const quiet = job => !alive(job.watchdogPid) && (TERMINAL.includes(job.status) ? job.terminalDelivery?.delivered !== false : !job.pauseDelivery);
    while (!quiet(stored(id))) { assert.ok(Date.now() < deadline, `job ${id} never settled`); pause(50); }
    return { file: fs.readFileSync(resolveJobFile(root, id), "utf8"), index: listJobs(root).find(job => job.id === id) };
  };
  const jobIds = () => new Set(listJobs(root).map(job => job.id));
  const plant = job => { writeJobFile(root, job.id, job); upsertJob(root, job); return job; };
  return { root, bin, env, schema, raw, cli, requests, record, jobIds, stored, plant };
}

const plantedRequest = ctx => ({ runner: "task", cwd: ctx.root, prompt: "planted", write: false });
const planted = (ctx, fields) => ctx.plant({ id: `task-${randomUUID()}`, kind: "task", jobClass: "task", workspaceRoot: ctx.root, threadId: randomUUID(), request: plantedRequest(ctx), ...fields });

describe("fork argv", () => {
  test("a fork streams stream-json with --fork and never --session-id", () => {
    const args = buildDroidExecArgs("/repo", "/tmp/prompt.txt", { forkThreadId: "parent-thread" });
    assert.equal(flagValue(args, "--output-format"), "stream-json");
    assert.equal(flagValue(args, "--fork"), "parent-thread");
    assert.ok(!args.includes("--session-id"), args.join(" "));
  });

  test("a schema repair after a fork continues the fork's own session and drops --fork", () => {
    const args = buildDroidExecArgs("/repo", "/tmp/prompt.txt", { forkThreadId: "parent-thread", resumeThreadId: "fork-thread", repair: true });
    assert.equal(flagValue(args, "--output-format"), "stream-json");
    assert.equal(flagValue(args, "--session-id"), "fork-thread");
    assert.ok(!args.includes("--fork"), args.join(" "));
  });
});

test("forking a completed job creates a new linked job and leaves the parent byte-identical", () => {
  const ctx = setup();
  const parent = ctx.cli("task", "--name", "origin", "Start the work");
  assert.equal(parent.status, "completed");
  const parentThread = ctx.stored(parent.jobId).threadId;
  const before = ctx.record(parent.jobId);
  const fork = ctx.cli("task", "--fork", "origin", "Try another approach");
  assert.deepEqual(ctx.record(parent.jobId), before);
  assert.notEqual(fork.jobId, parent.jobId);
  assert.equal(fork.status, "completed");
  const forked = ctx.stored(fork.jobId);
  assert.deepEqual(forked.forkedFrom, { jobId: parent.jobId, threadId: parentThread });
  // The link reaches every reader of a job, not just the stored file.
  const outputs = { status: ctx.cli("status", fork.jobId).job, "sessions find": ctx.cli("sessions", "find", fork.jobId).find(job => job.id === fork.jobId) };
  for (const [command, job] of Object.entries(outputs)) assert.deepEqual(job?.forkedFrom, forked.forkedFrom, command);
  assert.ok(!("forkedFrom" in ctx.cli("status", parent.jobId).job), "a job that is not a fork has no forkedFrom");
  assert.equal(forked.name, null);
  assert.equal(forked.kind, "task");
  assert.notEqual(forked.threadId, parentThread);
  const args = ctx.requests().at(-1).args;
  assert.equal(flagValue(args, "--fork"), parentThread);
  assert.equal(flagValue(args, "--output-format"), "stream-json");
  assert.ok(!args.includes("--session-id"), args.join(" "));
});

test("forking a resumed turn, whose request continues a session, never carries --session-id", () => {
  const ctx = setup();
  ctx.cli("task", "--name", "origin", "Start");
  const resumed = ctx.cli("sessions", "resume", "origin", "Next");
  assert.ok(ctx.stored(resumed.jobId).request.resumeThreadId);
  ctx.cli("task", "--fork", resumed.jobId, "Explore");
  const args = ctx.requests().at(-1).args;
  assert.equal(flagValue(args, "--fork"), ctx.stored(resumed.jobId).threadId);
  assert.ok(!args.includes("--session-id"), args.join(" "));
});

test("a fork replays the parent's worker options but not its brief", () => {
  const ctx = setup();
  const brief = path.join(ctx.root, "brief.md");
  fs.writeFileSync(brief, "brief-sentinel");
  ctx.cli("task", "--name", "origin", "--run-commands", "--brief", brief, "Start");
  ctx.cli("task", "--fork", "origin", "Next");
  const args = ctx.requests().at(-1).args;
  assert.equal(flagValue(args, "--auto"), "medium", "the parent's --run-commands fence carries over");
  const prompt = JSON.parse(fs.readFileSync(path.join(ctx.bin, "fake-droid-state.json"), "utf8")).lastTurnStart.prompt;
  assert.doesNotMatch(prompt, /brief-sentinel/);
});

test("the fork's schema repair resumes the fork's thread, not the parent's", () => {
  const ctx = setup();
  const parent = ctx.cli("task", "--name", "origin", "Start");
  const parentThread = ctx.stored(parent.jobId).threadId;
  installWorkerDroid(ctx.bin, "repair-once");
  const fork = ctx.cli("task", "--fork", "origin", "--output-schema", ctx.schema, "Count rows");
  assert.equal(fork.schemaValid, true);
  const [forkTurn, repairTurn] = ctx.requests().slice(-2);
  assert.equal(flagValue(forkTurn.args, "--fork"), parentThread);
  assert.ok(!repairTurn.args.includes("--fork"), repairTurn.args.join(" "));
  assert.equal(flagValue(repairTurn.args, "--session-id"), forkTurn.threadId);
  assert.notEqual(forkTurn.threadId, parentThread);
});

const ALLOWED_ROWS = {
  completed: ctx => ctx.cli("task", "--name", "parent", "Start").jobId,
  "awaiting-answer": ctx => {
    const paused = ctx.cli("task", "--name", "parent", "--pause-and-ask", "NEED_ANSWER");
    assert.equal(paused.status, "awaiting-answer");
    return paused.jobId;
  },
  failed: ctx => {
    installWorkerDroid(ctx.bin, "invalid-json");
    const failed = ctx.raw("task", "--name", "parent", "--output-schema", ctx.schema, "Count rows");
    assert.notEqual(failed.status, 0);
    installWorkerDroid(ctx.bin);
    const { jobId } = JSON.parse(failed.stdout);
    assert.equal(ctx.stored(jobId).status, "failed");
    return jobId;
  },
  cancelled: ctx => {
    const paused = ctx.cli("task", "--name", "parent", "--pause-and-ask", "NEED_ANSWER");
    assert.equal(ctx.cli("cancel", paused.jobId).status, "cancelled");
    return paused.jobId;
  },
  "already resumed": ctx => {
    const original = ctx.cli("task", "--name", "parent", "Start").jobId;
    ctx.cli("sessions", "resume", "parent", "Next");
    assert.ok(ctx.stored(original).resumedTo);
    return original;
  }
};

describe("parent states a fork accepts", () => {
  for (const [state, makeParent] of Object.entries(ALLOWED_ROWS)) {
    test(`${state}: creates a new job forking the record's own thread`, () => {
      const ctx = setup();
      const parentId = makeParent(ctx);
      const parentThread = ctx.stored(parentId).threadId;
      assert.ok(parentThread);
      const before = ctx.record(parentId);
      const fork = ctx.cli("task", "--fork", parentId, "Explore an alternative");
      assert.notEqual(fork.jobId, parentId);
      assert.deepEqual(ctx.stored(fork.jobId).forkedFrom, { jobId: parentId, threadId: parentThread });
      assert.equal(flagValue(ctx.requests().at(-1).args, "--fork"), parentThread);
      assert.deepEqual(ctx.record(parentId), before);
    });
  }
});

const REFUSED_ROWS = {
  unknown: () => ({ ref: "no-such-session", message: "Unknown session: no-such-session" }),
  ambiguous: ctx => {
    planted(ctx, { name: "twin", status: "completed" }); planted(ctx, { name: "twin", status: "completed" });
    return { ref: "twin", message: "Ambiguous session: twin" };
  },
  "no threadId": ctx => ({ ref: planted(ctx, { status: "failed", threadId: null }).id, message: NO_THREAD_MESSAGE }),
  "no request": ctx => ({ ref: planted(ctx, { status: "completed", request: undefined }).id, message: NO_THREAD_MESSAGE }),
  queued: ctx => ({ ref: planted(ctx, { status: "queued" }).id, message: RUNNING_MESSAGE }),
  running: ctx => ({ ref: planted(ctx, { status: "running" }).id, message: RUNNING_MESSAGE })
};

describe("parent states a fork refuses", () => {
  for (const [state, makeRow] of Object.entries(REFUSED_ROWS)) {
    test(`${state}: exits 1 with the session message and creates no job`, () => {
      const ctx = setup();
      ctx.cli("task", "Unrelated job");
      const { ref, message } = makeRow(ctx);
      const ids = ctx.jobIds();
      const result = ctx.raw("task", "--fork", ref, "Explore");
      assert.equal(result.status, 1, result.stdout);
      assert.equal(JSON.parse(result.stdout).message, message);
      assert.deepEqual(ctx.jobIds(), ids);
    });
  }
});

test("below the Droid floor a fork is refused with the floor message", () => {
  const ctx = setup({ FAKE_DROID_VERSION: "1.0.0" });
  ctx.cli("task", "--name", "origin", "Start");
  const ids = ctx.jobIds();
  const result = ctx.raw("task", "--fork", "origin", "Explore");
  assert.equal(result.status, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).message, `requires Droid CLI >= ${DROID_FEATURE_FLOOR} (found 1.0.0)`);
  assert.deepEqual(ctx.jobIds(), ids);
});

test("--fork cannot combine with --resume-last", () => {
  const ctx = setup();
  ctx.cli("task", "--name", "origin", "Start");
  const result = ctx.raw("task", "--fork", "origin", "--resume-last", "Explore");
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).message, "Choose either --resume/--resume-last or --fork.");
});

test("a fork takes a name only from its own --name, and that name must be free", () => {
  const ctx = setup();
  const parent = ctx.cli("task", "--name", "origin", "Start");
  const named = ctx.cli("task", "--fork", "origin", "--name", "alternative", "Explore");
  assert.equal(ctx.stored(named.jobId).name, "alternative");
  assert.equal(ctx.stored(parent.jobId).name, "origin");
  const clash = ctx.raw("task", "--fork", "origin", "--name", "origin", "Explore");
  assert.equal(clash.status, 1);
  assert.equal(JSON.parse(clash.stdout).message, 'Session "origin" already exists. Use sessions resume.');
});

test("a background fork runs to completion as its own job", () => {
  const ctx = setup();
  const parent = ctx.cli("task", "--name", "origin", "Start");
  const before = ctx.record(parent.jobId);
  const queued = ctx.cli("task", "--fork", "origin", "--background", "Explore");
  assert.notEqual(queued.jobId, parent.jobId);
  ctx.cli("status", queued.jobId, "--wait");
  assert.equal(ctx.stored(queued.jobId).status, "completed");
  assert.equal(flagValue(ctx.requests().at(-1).args, "--fork"), ctx.stored(parent.jobId).threadId);
  assert.deepEqual(ctx.record(parent.jobId), before);
});

test("live: a fork recalls a token its parent was told", { skip: process.env.DROID_SMOKE !== "1", timeout: 240000 }, () => {
  const cwd = makeTempDir(); initGitRepo(cwd);
  const env = smokeEnv();
  const token = `tok-${randomUUID().slice(0, 8)}`;
  const companion = args => {
    const result = run(process.execPath, [script, ...args, "--model", SMOKE_MODEL, "--json"], { cwd, env, timeout: 110000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const parent = companion(["task", "--name", "token-parent", `Remember this token: ${token}. Reply with the single word ok. Do not use tools.`]);
  assert.equal(parent.status, "completed");
  const fork = companion(["task", "--fork", "token-parent", "What token did I ask you to remember? Reply with the token only. Do not use tools."]);
  assert.equal(fork.status, "completed");
  assert.notEqual(fork.jobId, parent.jobId);
  assert.ok(fork.rawOutput.includes(token), fork.rawOutput);
});
