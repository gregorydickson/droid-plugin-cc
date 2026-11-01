import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildDroidExecArgs, runDroidTurn } from "../plugins/droid/scripts/lib/droid.mjs";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, run, writeExecutable } from "./helpers.mjs";
import { writeJobFile, upsertJob } from "../plugins/droid/scripts/lib/state.mjs";
import { resolveWorkspaceRoot } from "../plugins/droid/scripts/lib/workspace.mjs";
import { installFakeDroid, buildEnv } from "./fake-droid-fixture.mjs";

const flagValue = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const MISSION_FLAGS = ["--mission", "--worker-model", "--validator-model", "--worker-reasoning-effort", "--validator-reasoning-effort"];
const base = { mission: true, model: "glm-5.3", effort: "high" };

test("a mission turn runs --mission --auto high on stream-json with no tool fence", () => {
  for (const sandbox of [undefined, "read-only", "run-commands", "workspace-write"]) {
    const args = buildDroidExecArgs("/repo", "/p.txt", { ...base, sandbox, mcpTools: ["gt"] });
    assert.ok(args.includes("--mission"));
    assert.equal(flagValue(args, "--auto"), "high");
    assert.equal(flagValue(args, "--output-format"), "stream-json");
    for (const absent of ["--only-tools", "--add-tools", "--skip-permissions-unsafe"]) assert.ok(!args.includes(absent), `${absent} with sandbox ${sandbox}`);
  }
});

test("worker and validator take the explicit model and effort", () => {
  const args = buildDroidExecArgs("/repo", "/p.txt", { ...base, workerModel: "w-model", validatorModel: "v-model", workerEffort: "low", validatorEffort: "medium" });
  assert.deepEqual(
    Object.fromEntries(MISSION_FLAGS.slice(1).map(flag => [flag, flagValue(args, flag)])),
    { "--worker-model": "w-model", "--validator-model": "v-model", "--worker-reasoning-effort": "low", "--validator-reasoning-effort": "medium" });
  assert.equal(flagValue(args, "-m"), base.model);
  assert.equal(flagValue(args, "-r"), base.effort);
});

test("worker and validator fall back to the resolved main model and effort, each independently", () => {
  const defaulted = buildDroidExecArgs("/repo", "/p.txt", base);
  for (const flag of ["--worker-model", "--validator-model"]) assert.equal(flagValue(defaulted, flag), base.model);
  for (const flag of ["--worker-reasoning-effort", "--validator-reasoning-effort"]) assert.equal(flagValue(defaulted, flag), base.effort);
  const mixed = buildDroidExecArgs("/repo", "/p.txt", { ...base, workerModel: "w-model", validatorEffort: "low" });
  assert.equal(flagValue(mixed, "--worker-model"), "w-model");
  assert.equal(flagValue(mixed, "--validator-model"), base.model);
  assert.equal(flagValue(mixed, "--worker-reasoning-effort"), base.effort);
  assert.equal(flagValue(mixed, "--validator-reasoning-effort"), "low");
});

test("a flag with no value to carry is omitted rather than passed empty", () => {
  const args = buildDroidExecArgs("/repo", "/p.txt", { mission: true });
  for (const flag of MISSION_FLAGS.slice(1)) assert.ok(!args.includes(flag), flag);
  assert.ok(args.includes("--mission"));
});

test("a schema repair turn built with mission: true carries no mission flags", () => {
  const args = buildDroidExecArgs("/repo", "/p.txt", { ...base, workerModel: "w", validatorModel: "v", workerEffort: "low", validatorEffort: "low", repair: true, resumeThreadId: "s-1" });
  for (const flag of MISSION_FLAGS) assert.ok(!args.includes(flag), flag);
  assert.notEqual(flagValue(args, "--auto"), "high");
  assert.ok(args.includes("--only-tools"));
});

test("a non-mission turn is unchanged by the mission options", () => {
  const without = buildDroidExecArgs("/repo", "/p.txt", { sandbox: "read-only", model: "m" });
  const withOpts = buildDroidExecArgs("/repo", "/p.txt", { sandbox: "read-only", model: "m", workerModel: "w", validatorEffort: "low" });
  assert.deepEqual(withOpts, without);
});

function missionFake(t, behavior = "review-ok") {
  const bin = makeTempDir(); installFakeDroid(bin, behavior, true);
  const old = process.env.DROID_BINARY;
  process.env.DROID_BINARY = buildEnv(bin).DROID_BINARY;
  t.after(() => { if (old === undefined) delete process.env.DROID_BINARY; else process.env.DROID_BINARY = old; });
  return () => JSON.parse(fs.readFileSync(path.join(bin, "fake-droid-state.json")));
}

test("a fake mission turn emitting the recorded event sequence completes with status 0 and the final message", async t => {
  const state = missionFake(t);
  const result = await runDroidTurn(makeTempDir(), { ...base, prompt: "Create hello.txt" });
  assert.equal(result.status, 0, JSON.stringify(result.error));
  assert.equal(result.finalMessage, "Mission finished.");
  assert.ok(result.threadId);
  const [request] = state().threadRequests;
  assert.ok(request.args.includes("--mission"));
  assert.equal(flagValue(request.args, "--worker-model"), base.model);
});

test("a mission that exits without its completion event fails", async t => {
  missionFake(t, "no-completion");
  const result = await runDroidTurn(makeTempDir(), { ...base, prompt: "Create hello.txt" });
  assert.equal(result.status, 1);
  assert.ok(result.error);
});

const script = fileURLToPath(new URL("../plugins/droid/scripts/droid-companion.mjs", import.meta.url));
const GOAL = "Create hello.txt";

function missionCli(t, { behavior = "review-ok", env: extraEnv = {}, lane = false } = {}) {
  const root = makeTempDir(); initGitRepo(root);
  fs.writeFileSync(path.join(root, "README.md"), "mission\n");
  run("git", ["add", "."], { cwd: root }); run("git", ["commit", "-m", "initial"], { cwd: root });
  const bin = makeTempDir(); installFakeDroid(bin, behavior, true);
  const env = { ...buildEnv(bin), DROID_HOME: makeTempDir(), CLAUDE_PLUGIN_DATA: makeTempDir(), DROID_COMPANION_SESSION_ID: "mission-tests", ...extraEnv };
  if (lane) {
    env.DROID_BINARY = path.join(bin, "droid-lock.sh");
    writeExecutable(env.DROID_BINARY, fs.readFileSync(path.join(bin, "droid.cjs"), "utf8"));
  }
  const statePath = path.join(bin, "fake-droid-state.json");
  const invoke = (...args) => run(process.execPath, [script, ...args], { cwd: root, env });
  const cli = (...args) => {
    const result = invoke(...args, "--json");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  const lastArgs = () => JSON.parse(fs.readFileSync(statePath)).threadRequests.at(-1).args;
  return { root, bin, env, statePath, invoke, cli, lastArgs };
}

const LANE_MESSAGE = "missions cannot run under the lane lock wrapper (it refuses --mission).";
const GOAL_MESSAGE = "Provide a mission goal.";
const REJECTED_VALUE_FLAGS = ["--name", "--fanout", "--brief", "--preread", "--fork"];
const REJECTED_BOOLEAN_FLAGS = ["--persistent", "--pause-and-ask", "--read-only", "--run-commands", "--write", "--steerable", "--spec"];
const refusedBy = flag => `${flag} is not supported by mission.`;
const REFUSALS = [
  ...REJECTED_VALUE_FLAGS.map(flag => ({ name: flag, argv: [flag, "x", GOAL], message: refusedBy(flag) })),
  ...REJECTED_BOOLEAN_FLAGS.map(flag => ({ name: flag, argv: [flag, GOAL], message: refusedBy(flag) })),
  { name: "empty goal", argv: [], message: GOAL_MESSAGE },
  { name: "blank goal", argv: ["  ", " "], message: GOAL_MESSAGE },
  { name: "lane wrapper", argv: [GOAL], lane: true, message: LANE_MESSAGE },
  { name: "version floor", argv: [GOAL], env: { FAKE_DROID_VERSION: "1.0.0" }, message: "requires Droid CLI >= 1.1.0 (found 1.0.0)" },
  { name: "a rejected flag is refused before an empty goal", argv: ["--write"], lane: true, message: refusedBy("--write") },
  { name: "an empty goal is refused before the lane wrapper", argv: [], lane: true, message: GOAL_MESSAGE },
  { name: "the lane wrapper is refused before the version floor", argv: [GOAL], lane: true, env: { FAKE_DROID_VERSION: "1.0.0" }, message: LANE_MESSAGE }
];

for (const { name, argv, message, lane, env } of REFUSALS) {
  test(`mission refuses: ${name}`, t => {
    const fixture = missionCli(t, { lane, env });
    const result = fixture.invoke("mission", ...argv);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stderr, `${message}\n`);
    assert.ok(!fs.existsSync(fixture.statePath), "no droid exec ran");
  });
}

test("a mission starts in a repo with a push remote and no extra flag", t => {
  const fixture = missionCli(t);
  const remote = makeTempDir(); run("git", ["init", "--bare", "-b", "main"], { cwd: remote });
  run("git", ["remote", "add", "origin", remote], { cwd: fixture.root });
  assert.equal(run("git", ["push", "-u", "origin", "main"], { cwd: fixture.root }).status, 0);
  const payload = fixture.cli("mission", GOAL);
  assert.equal(payload.rawOutput, "Mission finished.");
  const job = fixture.cli("status").latestFinished;
  assert.deepEqual({ kind: job.kind, kindLabel: job.kindLabel, status: job.status }, { kind: "mission", kindLabel: "mission", status: "completed" });
  assert.ok(fixture.lastArgs().includes("--mission"));
});

const waitForStatus = (fixture, jobId) => fixture.cli("status", jobId, "--wait", "--timeout-ms", "10000").job;

test("a background mission reports label mission in status and its final message in result", t => {
  const fixture = missionCli(t);
  const launched = fixture.cli("mission", "--background", GOAL);
  assert.equal(launched.status, "queued");
  const job = waitForStatus(fixture, launched.jobId);
  assert.deepEqual({ kind: job.kind, kindLabel: job.kindLabel, status: job.status }, { kind: "mission", kindLabel: "mission", status: "completed" });
  assert.match(fixture.invoke("status", launched.jobId).stdout, /\bmission\b/);
  assert.equal(fixture.cli("result", launched.jobId).result.rawOutput, "Mission finished.");
  assert.match(fixture.invoke("result", launched.jobId).stdout, /Mission finished\./);
  const args = fixture.lastArgs();
  assert.ok(args.includes("--mission"));
  assert.deepEqual(JSON.parse(flagValue(args, "--tag")).metadata, { jobId: launched.jobId, kind: "mission" });
});

test("cancel on a running mission marks it cancelled", { timeout: 20000 }, async t => {
  const fixture = missionCli(t, { behavior: "stubborn-task" });
  const launched = fixture.cli("mission", "--background", GOAL);
  let state;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !state?.descendantPid) {
    if (fs.existsSync(fixture.statePath)) state = JSON.parse(fs.readFileSync(fixture.statePath));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(state?.descendantPid, "the mission did not start");
  t.after(() => { for (const pid of [state.rootPid, state.descendantPid]) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  assert.ok(state.threadRequests.at(-1).args.includes("--mission"));
  assert.equal(fixture.cli("cancel", launched.jobId).status, "cancelled");
  const job = fixture.cli("status", launched.jobId).job;
  assert.deepEqual({ kindLabel: job.kindLabel, status: job.status }, { kindLabel: "mission", status: "cancelled" });
  assert.equal(fixture.cli("result", launched.jobId).status, "cancelled");
});

test("a mission record without a stored label still shows label mission", t => {
  const fixture = missionCli(t);
  const old = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fixture.env.CLAUDE_PLUGIN_DATA;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = old; });
  const workspaceRoot = resolveWorkspaceRoot(fixture.root);
  const record = { id: "mission-legacy", kind: "mission", jobClass: "mission", status: "completed", workspaceRoot, sessionId: "mission-tests", completedAt: new Date().toISOString() };
  writeJobFile(workspaceRoot, record.id, record); upsertJob(workspaceRoot, record);
  const job = fixture.cli("status", record.id).job;
  assert.equal(job.kindLabel, "mission");
});

test("a finished mission cannot be resumed or forked as a task", t => {
  const fixture = missionCli(t);
  fixture.cli("mission", GOAL);
  const missionId = fixture.cli("status").latestFinished.id;
  for (const argv of [["task", "--fork", missionId, "Explore"], ["sessions", "resume", missionId, "Continue"]]) {
    const result = fixture.invoke(...argv);
    assert.equal(result.status, 1, argv.join(" "));
    assert.equal(result.stderr, "A mission cannot be resumed or forked; start a new mission.\n", argv.join(" "));
  }
});
