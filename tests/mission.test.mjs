import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildDroidExecArgs, runDroidTurn } from "../plugins/droid/scripts/lib/droid.mjs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { makeTempDir, initGitRepo, run, writeExecutable, smokeEnv, SMOKE_MODEL } from "./helpers.mjs";
import { TERMINAL_STATUSES } from "../plugins/droid/scripts/lib/tracked-jobs.mjs";
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

const missionDoc = () => fs.readFileSync(new URL("../plugins/droid/commands/mission.md", import.meta.url), "utf8");
const ORCHESTRATOR_ONLY = "cancel stops only the orchestrator; mission workers may keep running.";

// docs/missions.md ends with the recorded findings; its Cancel: line says what cancel stops.
function recordedCancelScope() {
  const lines = fs.readFileSync(new URL("../docs/missions.md", import.meta.url), "utf8").split("\n").filter(line => line.trim());
  const scope = lines.slice(-2).map(line => line.match(/^Cancel: (full|orchestrator-only)$/)?.[1]).find(Boolean);
  assert.ok(scope, "docs/missions.md must end with a Cancel: line");
  return scope;
}

test("mission.md states the refusals and the cancel scope the runtime and docs/missions.md record", () => {
  const doc = missionDoc();
  const scope = recordedCancelScope();
  assert.equal(doc.includes(ORCHESTRATOR_ONLY), scope === "orchestrator-only", `Cancel: ${scope}`);
  if (scope === "full") assert.match(doc, /`\/droid:cancel` stops the orchestrator and every worker and validator it started/);
  assert.ok(doc.toLowerCase().includes(LANE_MESSAGE.slice(0, LANE_MESSAGE.indexOf(" ("))), "mission.md names the lane wrapper refusal");
  const refusalLine = doc.split("\n").find(line => line.includes("It refuses `--"));
  assert.ok(refusalLine, "mission.md lists the refused flags");
  assert.deepEqual(new Set(refusalLine.match(/--[a-z-]+/g)), new Set([...REJECTED_VALUE_FLAGS, ...REJECTED_BOOLEAN_FLAGS]));
});

// Live missions spend Factory credits: DROID_SMOKE_MISSION=1 only, real login, a temp repo with no remote.
const live = { skip: process.env.DROID_SMOKE_MISSION !== "1", timeout: 600000 };
const LIVE_GOAL = "Create hello.txt containing the word hi, then stop.";
const LIVE_CANCEL_GOAL = "Do not create or edit any file yourself. Start exactly one worker for this mission. "
  + "The worker must first run the shell command `sleep 120`, then create hello.txt containing the word hi.";
const SETTLE_MS = 540000;
const CANCEL_FALLBACK_MS = 240000;
const AFTER_CANCEL_MS = 10000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function liveMission(t) {
  const cwd = fs.realpathSync(makeTempDir("droid-mission-live-")); initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "live mission\n");
  run("git", ["add", "."], { cwd }); run("git", ["commit", "-m", "initial"], { cwd });
  assert.equal(run("git", ["remote"], { cwd }).stdout.trim(), "", "a live mission repo must have no remote");
  const env = { ...smokeEnv(), DROID_COMPANION_SESSION_ID: "mission-live" };
  const cli = (...args) => {
    const result = run(process.execPath, [script, ...args, "--json"], { cwd, env, timeout: 60000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const start = goal => {
    const launched = cli("mission", "--background", "--model", SMOKE_MODEL, goal);
    assert.equal(launched.status, "queued");
    t.after(() => run(process.execPath, [script, "cancel", launched.jobId, "--json"], { cwd, env, timeout: 60000 }));
    return launched.jobId;
  };
  return { cwd, cli, start };
}

async function settle(mission, jobId) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const job = mission.cli("status", jobId).job;
    if (TERMINAL_STATUSES.has(job.status) || Date.now() > deadline) return job;
    await sleep(5000);
  }
}

function processes() {
  const out = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 10000 }).stdout ?? "";
  return out.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

// Every process naming the job id (the companion worker and the droid exec, whose --tag
// carries it) plus everything they spawned: the orchestrator, its workers and their tools.
function missionTree(procs, jobId) {
  const tree = new Set(procs.filter(proc => proc.command.includes(jobId)).map(proc => proc.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const proc of procs) if (!tree.has(proc.pid) && tree.has(proc.ppid)) { tree.add(proc.pid); grew = true; }
  }
  return procs.filter(proc => tree.has(proc.pid));
}

const isMissionWorker = proc => proc.command.includes("--input-format stream-jsonrpc");

test("live: a glm mission runs to completed and records its Droid session", live, async t => {
  const mission = liveMission(t);
  const job = await settle(mission, mission.start(LIVE_GOAL));
  assert.deepEqual({ kind: job.kind, status: job.status, model: job.model }, { kind: "mission", status: "completed", model: SMOKE_MODEL },
    JSON.stringify(job.progressPreview));
  assert.equal(typeof job.threadId, "string");
  assert.notEqual(job.threadId.trim(), "", "a completed mission records its Droid session id");
  assert.match(fs.readFileSync(path.join(mission.cwd, "hello.txt"), "utf8"), /\bhi\b/i);
});

test("live: cancel stops what docs/missions.md says it stops", live, async t => {
  const mission = liveMission(t);
  const jobId = mission.start(LIVE_CANCEL_GOAL);
  const seen = new Map();
  t.after(() => { for (const pid of seen.keys()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } });
  const started = Date.now();
  let job;
  for (;;) {
    job = mission.cli("status", jobId).job;
    for (const proc of missionTree(processes(), jobId)) if (!seen.has(proc.pid)) seen.set(proc.pid, proc);
    if (TERMINAL_STATUSES.has(job.status) || [...seen.values()].some(isMissionWorker) || Date.now() - started > CANCEL_FALLBACK_MS) break;
    await sleep(2000);
  }
  assert.equal(job.status, "running", `the mission must still be running when cancelled: ${JSON.stringify(job.progressPreview)}`);
  assert.equal(mission.cli("cancel", jobId).status, "cancelled");
  await sleep(AFTER_CANCEL_MS);
  const scope = recordedCancelScope();
  if (scope === "orchestrator-only") {
    assert.ok(missionDoc().includes(ORCHESTRATOR_ONLY), "docs/missions.md says Cancel: orchestrator-only, so mission.md must say so");
    return;
  }
  assert.ok([...seen.values()].some(isMissionWorker), "no mission worker started before the cancel, so cancel was not checked against workers");
  const needles = [jobId, job.threadId].filter(Boolean);
  const survivors = processes().filter(proc => seen.get(proc.pid)?.command === proc.command || needles.some(needle => proc.command.includes(needle)));
  assert.deepEqual(survivors, [], "docs/missions.md says Cancel: full, but mission processes outlived the cancel");
});
