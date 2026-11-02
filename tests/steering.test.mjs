import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";
import { listJobs, readJobFile, resolveJobFile, resolveJobsDir, upsertJob, writeJobFile } from "../plugins/droid/scripts/lib/state.mjs";
import { steeringSocketPath } from "../plugins/droid/scripts/lib/tracked-jobs.mjs";
import { installFakeDroid, buildEnv, SESSION_USAGE } from "./fake-droid-fixture.mjs";
import { buildDroidExecArgs, interruptDroidTurn, runSteerableSession } from "../plugins/droid/scripts/lib/droid.mjs";
import { jobUsage } from "../plugins/droid/scripts/lib/job-results.mjs";

const TEST_TIMEOUT_MS = 20000;
const IDLE_MS = "200";
const LONG_IDLE_MS = "60000";
const SANDBOXES = ["read-only", "run-commands", "workspace-write"];
const ONE_SHOT_FENCE_FLAGS = ["--tag", "--only-tools", "--auto", "--add-tools", "-m", "-r"];
const SCHEMA = { type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false };
const flagValue = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

function fixture(behavior = "review-ok", extraEnv = {}) {
  const cwd = fs.realpathSync(makeTempDir("droid-steer-repo-"));
  const bin = makeTempDir("droid-steer-bin-");
  installFakeDroid(bin, behavior);
  const env = { ...buildEnv(bin), DROID_STEER_IDLE_MS: IDLE_MS, ...extraEnv };
  const statePath = path.join(bin, "fake-droid-state.json");
  const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
  // The fake rewrites its state file on every request, so a poll can land before it exists or mid-write.
  const inputRequests = () => { try { return state().inputRequests ?? []; } catch { return []; } };
  const requests = method => inputRequests().filter(request => request.method === method);
  const userTexts = () => requests("droid.add_user_message").map(request => request.params.text);
  return { cwd, bin, env, state, inputRequests, requests, userTexts };
}

async function untilSent(f, text) {
  while (!f.userTexts().includes(text)) await new Promise(resolve => setTimeout(resolve, 20));
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** True once `pid` has gone; an orphan's SIGKILL lands asynchronously, so one probe can still see it. */
async function exits(pid, deadline = Date.now() + 5000) {
  while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  return !alive(pid);
}

/** Resolves with the session once its first turn's answer is reported. */
function startAndAwaitFirstAnswer(f, options = {}) {
  let session;
  const answered = new Promise(resolve => {
    session = runSteerableSession(f.cwd, { prompt: "first", env: f.env, ...options,
      onProgress: ({ logBody }) => { if (logBody) resolve(); } });
  });
  return answered.then(() => session);
}

for (const sandbox of SANDBOXES) {
  test(`a steered ${sandbox} job sets the one-shot turn's model, effort, autonomy and tool list over JSON-RPC`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const f = fixture();
    const options = { sandbox, model: "glm-5.3", effort: "low", mcpTools: ["docs/search"], tag: { jobId: "task-steer", kind: "task" } };
    const result = await runSteerableSession(f.cwd, { prompt: "first", env: f.env, ...options }).done;
    assert.equal(result.status, 0, JSON.stringify(result.error));
    const oneShot = buildDroidExecArgs(f.cwd, "/prompt.txt", options);
    const list = flag => flagValue(oneShot, flag)?.split(",");
    const [init] = f.requests("droid.initialize_session");
    const fence = Object.fromEntries(Object.entries({
      modelId: flagValue(oneShot, "-m"), reasoningEffort: flagValue(oneShot, "-r"), autonomyLevel: flagValue(oneShot, "--auto") ?? "off",
      restrictToolIds: list("--only-tools"), additionalToolIds: list("--add-tools")
    }).filter(([, value]) => value !== undefined));
    assert.deepEqual(Object.fromEntries(Object.keys(fence).map(key => [key, init.params[key]])), fence);
    assert.equal(init.params.cwd, f.cwd);
    const argv = f.state().inputArgs;
    for (const flag of ONE_SHOT_FENCE_FLAGS) assert.ok(!argv.includes(flag), `${flag} in ${argv.join(" ")}`);
    assert.equal(flagValue(argv, "--input-format"), "stream-jsonrpc");
    assert.ok(!("steeringWarning" in result), result.steeringWarning);
  });
}

test("a steered job whose autonomy and tool list droid does not apply runs with a warning naming both", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture("review-ok", { FAKE_DROID_IGNORE_SETTINGS: "autonomyLevel,restrictToolIds" });
  const result = await runSteerableSession(f.cwd, { prompt: "first", env: f.env, sandbox: "read-only", model: "glm-5.3" }).done;
  assert.equal(result.status, 0, JSON.stringify(result.error));
  for (const name of ["autonomy", "tool list"]) assert.match(result.steeringWarning, new RegExp(`ignores the requested[^;]*${name}.*session's[^;]*${name}`));
});

test("a steered job whose model droid does not apply fails before any user turn", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture("review-ok", { FAKE_DROID_IGNORE_SETTINGS: "modelId" });
  const result = await runSteerableSession(f.cwd, { prompt: "first", env: f.env, model: "glm-5.3", effort: "low" }).done;
  assert.equal(result.status, 1);
  assert.match(result.error.message, /did not apply the steered job's model \(glm-5\.3\)/);
  assert.deepEqual(f.userTexts(), []);
});

test("two queued user turns complete separately and the job ends after the idle window with the last answer and session usage", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture("review-ok", { FAKE_DROID_TURN_MS: "150" });
  const session = runSteerableSession(f.cwd, { prompt: "first", env: f.env });
  await untilSent(f, "first");
  session.sendUserTurn("second");
  const result = await session.done;
  assert.equal(result.status, 0, JSON.stringify(result.error));
  assert.deepEqual(f.userTexts(), ["first", "second"]);
  assert.equal(result.finalMessage, "Answered: second");
  const sessionTotal = f.state().sessionTurns[result.threadId];
  const cumulative = turn => Object.fromEntries(Object.keys(SESSION_USAGE[0]).map(key => [key, SESSION_USAGE[0][key] + (turn - 1) * (SESSION_USAGE[1][key] - SESSION_USAGE[0][key])]));
  assert.deepEqual(result.usage, cumulative(sessionTotal));
  const previousJob = cumulative(sessionTotal - 1);
  const perTurn = Object.fromEntries(Object.keys(SESSION_USAGE[0]).map(key => [key, SESSION_USAGE[1][key] - SESSION_USAGE[0][key]]));
  assert.deepEqual(jobUsage(result.usage, previousJob), perTurn);
  assert.throws(() => session.sendUserTurn("late"), /session has ended/);
});

test("a message sent inside the idle window runs as the next turn", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture("review-ok", { DROID_STEER_IDLE_MS: LONG_IDLE_MS });
  const session = await startAndAwaitFirstAnswer(f);
  session.sendUserTurn("second");
  session.end();
  const result = await session.done;
  assert.deepEqual(f.userTexts(), ["first", "second"]);
  assert.equal(result.finalMessage, "Answered: second");
});

test("end() closes the session and leaves no live droid child", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture("review-ok", { DROID_STEER_IDLE_MS: LONG_IDLE_MS });
  const session = await startAndAwaitFirstAnswer(f);
  session.end();
  const result = await session.done;
  assert.equal(result.status, 0, JSON.stringify(result.error));
  assert.equal(result.finalMessage, "Answered: first");
  assert.ok(!alive(session.pid), `droid ${session.pid} still running`);
});

test("end() kills a child that keeps running after its input closes", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture("review-ok", { DROID_STEER_IDLE_MS: LONG_IDLE_MS, FAKE_DROID_INPUT: "hold" });
  const session = await startAndAwaitFirstAnswer(f, { exitGraceMs: 200 });
  session.end();
  const result = await session.done;
  assert.equal(result.status, 0, JSON.stringify(result.error));
  assert.ok(!alive(session.pid), `droid ${session.pid} still running`);
});

test("a session whose droid exits leaves none of droid's descendants running", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture("review-ok", { DROID_STEER_IDLE_MS: LONG_IDLE_MS, FAKE_DROID_INPUT: "orphan" });
  const session = await startAndAwaitFirstAnswer(f);
  const descendant = f.state().inputDescendantPid;
  assert.ok(alive(descendant), `descendant ${descendant} never started`);
  session.end();
  const result = await session.done;
  assert.equal(result.status, 0, JSON.stringify(result.error));
  assert.ok(await exits(descendant), `descendant ${descendant} still running`);
});

test("cancelling a running steered turn kills the child and fails the job", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture("review-ok", { FAKE_DROID_TURN_MS: LONG_IDLE_MS });
  const session = runSteerableSession(f.cwd, { prompt: "first", env: f.env });
  await untilSent(f, "first");
  assert.equal(interruptDroidTurn(f.cwd, { turnId: session.turnId }).interrupted, true);
  const result = await session.done;
  assert.equal(result.status, 1);
  assert.equal(result.error.message, "Droid exited without a turn completion event.");
  assert.ok(!alive(session.pid), `droid ${session.pid} still running`);
});

test("a child that exits before any completion fails with the missing-completion error", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture("review-ok", { FAKE_DROID_INPUT: "exit" });
  const result = await runSteerableSession(f.cwd, { prompt: "first", env: f.env }).done;
  assert.equal(result.status, 1);
  assert.equal(result.error.message, "Droid exited without a turn completion event.");
});

test("a request droid sends the client is answered with an error so the session keeps going", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture("review-ok", { FAKE_DROID_INPUT: "permission" });
  const result = await runSteerableSession(f.cwd, { prompt: "first", env: f.env }).done;
  assert.equal(result.status, 0, JSON.stringify(result.error));
  const reply = f.state().inputRequests.find(message => message.id === "permission-1");
  assert.equal(reply?.type, "response");
  assert.match(reply.error.message, /droid\.request_permission/);
});

test("the final steered answer is schema-checked and repaired once by a one-shot resume of the session", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture("repair-once");
  const result = await runSteerableSession(f.cwd, { prompt: "count rows", env: f.env, outputSchema: SCHEMA }).done;
  assert.equal(result.status, 0, JSON.stringify(result.error));
  assert.deepEqual(JSON.parse(result.finalMessage), { count: 2 });
  assert.match(f.userTexts().at(-1), /Return only JSON matching this JSON schema/);
  const repair = f.state().threadRequests.at(-1).args;
  assert.equal(flagValue(repair, "--session-id"), f.state().threads.find(thread => thread.cwd === f.cwd).id);
  assert.ok(!repair.includes("--input-format"), repair.join(" "));
});

// ---- send over a task --steerable job's socket, through the CLI ----

const PLUGIN_DIR = fileURLToPath(new URL("../plugins/droid", import.meta.url));
const CLI_TIMEOUT_MS = 120000;
const PROMPT = "steer me";
const DECISION_LINES = { GO: "Decision: GO", "GO-WARN": "Decision: GO-WARN — not settable: autonomy, tool list" };
const UNSETTABLE = DECISION_LINES["GO-WARN"].split(": ").at(-1).split(", ");
const SANDBOX_FLAGS = { "read-only": [], "run-commands": ["--run-commands"], write: ["--write"], "read-only under droid-lock.sh": [] };
const companions = new Map();

/** A copy of the plugin whose repository's docs/live-steering.md ends with `decision`'s line. */
function companionWith(decision) {
  if (!companions.has(decision)) {
    const root = makeTempDir("droid-steer-plugin-");
    fs.cpSync(PLUGIN_DIR, path.join(root, "plugins", "droid"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs", "live-steering.md"), `# Live steering\n\n## Decision\n\n${DECISION_LINES[decision]}\n`);
    companions.set(decision, path.join(root, "plugins", "droid", "scripts", "droid-companion.mjs"));
  }
  return companions.get(decision);
}

async function until(probe, what, deadline = Date.now() + 30000) {
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function cliFixture(t, { decision = "GO", lane = false, env: extraEnv = {} } = {}) {
  const f = fixture("review-ok", { DROID_STEER_IDLE_MS: LONG_IDLE_MS, ...extraEnv });
  initGitRepo(f.cwd);
  fs.writeFileSync(path.join(f.cwd, "README.md"), "steer\n");
  run("git", ["add", "."], { cwd: f.cwd }); run("git", ["commit", "-m", "initial"], { cwd: f.cwd });
  const data = makeTempDir("droid-steer-data-");
  const env = { ...f.env, CLAUDE_PLUGIN_DATA: data, DROID_COMPANION_SESSION_ID: "steer-tests" };
  if (lane) {
    env.DROID_BINARY = path.join(f.bin, "droid-lock.sh");
    writeExecutable(env.DROID_BINARY, fs.readFileSync(path.join(f.bin, "droid.cjs"), "utf8"));
  }
  const script = companionWith(decision);
  const invoke = (...args) => run(process.execPath, [script, ...args], { cwd: f.cwd, env, timeout: 30000 });
  // The state helpers resolve the data dir from process.env at call time.
  const withData = action => {
    const previous = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = data;
    try { return action(); } finally { if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous; }
  };
  const job = id => withData(() => { try { return readJobFile(resolveJobFile(f.cwd, id)); } catch { return null; } });
  const write = record => withData(() => { writeJobFile(f.cwd, record.id, record); upsertJob(f.cwd, record); });
  const started = [];
  const launch = (...flags) => {
    const result = invoke("task", "--steerable", "--background", "--json", ...flags, PROMPT);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const { jobId } = JSON.parse(result.stdout);
    started.push(jobId);
    return { jobId, stderr: result.stderr };
  };
  const steerable = async id => until(() => { const record = job(id); return record?.status === "running" && record.socketPath && fs.existsSync(record.socketPath) && record; }, `${id}'s steering socket`);
  const finished = async id => until(() => { const record = job(id); return ["completed", "failed", "cancelled"].includes(record?.status) && !record.finalization && record; }, `${id} to finish`);
  t.after(() => { for (const id of started) if (["queued", "running"].includes(job(id)?.status)) invoke("cancel", id); });
  return { ...f, data, env, invoke, job, write, launch, steerable, finished, withData };
}

test("task --steerable requires --background", { timeout: CLI_TIMEOUT_MS }, t => {
  const c = cliFixture(t);
  const result = c.invoke("task", "--steerable", PROMPT);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "--steerable requires --background.");
});

test("task --steerable is refused below the Droid version floor", { timeout: CLI_TIMEOUT_MS }, t => {
  const c = cliFixture(t, { env: { FAKE_DROID_VERSION: "1.0.0" } });
  const result = c.invoke("task", "--steerable", "--background", PROMPT);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires Droid CLI >= 1\.1\.0 \(found 1\.0\.0\)/);
});

/** A stale socket file: a listener that died without unlinking it. */
function staleSocket(dir) {
  const socketPath = path.join(dir, "stale.sock");
  spawnSync(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, "SIGKILL"))`], { timeout: 10000 });
  assert.ok(fs.existsSync(socketPath), "stale socket was not left behind");
  return socketPath;
}

test("every send to a target that cannot take the message exits 1 with its reason and writes nothing to droid", { timeout: CLI_TIMEOUT_MS }, async t => {
  const c = cliFixture(t);
  const done = c.launch();
  await c.steerable(done.jobId);
  assert.equal(c.invoke("send", done.jobId, "--end").status, 0);
  await c.finished(done.jobId);
  const live = c.launch();
  const running = await c.steerable(live.jobId);
  await untilSent(c, PROMPT);
  // Copies of the live record keep its socket, so only the refusal stands between the message and droid.
  const forged = (suffix, change) => { const record = { ...running, id: `${running.id}-${suffix}`, name: null, ...change }; c.write(record); return record.id; };
  const plain = forged("plain", { steerable: false });
  const paused = forged("paused", { status: "awaiting-answer" });
  const stale = forged("stale", { socketPath: staleSocket(makeTempDir("droid-steer-stale-")) });
  const rows = [
    ["an unknown ref", ["nope", "hello"], "Unknown session: nope"],
    ["a completed job", [done.jobId, "hello"], "Job is not running."],
    ["a job started without --steerable", [plain, "hello"], "Job was not started with --steerable."],
    ["a job awaiting an answer", [paused, "hello"], "Job is awaiting an answer; use answer <ref> <text>."],
    ["a job whose socket file is stale", [stale, "hello"], "Steering socket is unavailable."],
    ["an empty message", [live.jobId, "  "], "Provide a message or --file."]
  ];
  for (const [label, args, message] of rows) {
    const before = c.inputRequests();
    const result = c.invoke("send", ...args);
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert.equal(result.stderr.trim(), message, label);
    assert.equal(result.stdout, "", label);
    assert.deepEqual(c.inputRequests(), before, label);
  }
  // A refused message that slipped through would reach droid ahead of this one.
  assert.equal(c.invoke("send", live.jobId, "probe").status, 0);
  await untilSent(c, "probe");
  assert.deepEqual(c.userTexts(), [PROMPT, "probe"]);
});

test("send queues the message as the next user turn mid-turn, and cancel removes the socket and the droid child", { timeout: CLI_TIMEOUT_MS }, async t => {
  const c = cliFixture(t, { env: { FAKE_DROID_TURN_MS: "1500" } });
  const { jobId } = c.launch();
  const record = await c.steerable(jobId);
  await untilSent(c, PROMPT);
  const file = path.join(makeTempDir("droid-steer-msg-"), "message.txt");
  fs.writeFileSync(file, "second line one\nsecond line two");
  const sent = c.invoke("send", jobId, "--file", file);
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(sent.stdout, `sent to ${jobId}\n`);
  assert.deepEqual(c.userTexts(), [PROMPT], "the message must wait for the running turn");
  await untilSent(c, "second line one\nsecond line two");
  assert.deepEqual(c.userTexts(), [PROMPT, "second line one\nsecond line two"]);
  const droidPid = c.state().inputPid;
  const cancelled = c.invoke("cancel", jobId, "--json");
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  assert.ok(await until(() => !fs.existsSync(record.socketPath), "the socket file to go"));
  assert.ok(await exits(droidPid), `droid ${droidPid} still running`);
});

test("the steering socket sits in the jobs dir unless that path overflows sun_path, then in a short temp path", () => {
  const jobId = "task-steer-path";
  const withRoot = (root, action) => {
    const previous = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = root;
    try { return action(); } finally { if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous; }
  };
  const short = withRoot(fs.mkdtempSync("/tmp/ds-"), () => [steeringSocketPath("/r", jobId), path.join(resolveJobsDir("/r"), `${jobId}.sock`)]);
  assert.equal(short[0], short[1]);
  const long = withRoot(path.join(makeTempDir(), "x".repeat(100)), () => steeringSocketPath("/r", jobId));
  assert.equal(long, path.join(os.tmpdir(), `droid-${createHash("sha256").update(jobId).digest("hex").slice(0, 12)}.sock`));
  for (const socketPath of [short[0], long]) assert.ok(Buffer.byteLength(socketPath) <= 100, socketPath);
});

test("a running steerable job records the socket path the worker listens on", { timeout: CLI_TIMEOUT_MS }, async t => {
  const c = cliFixture(t);
  const { jobId } = c.launch();
  const { socketPath } = await c.steerable(jobId);
  assert.equal(socketPath, c.withData(() => steeringSocketPath(c.cwd, jobId)));
  assert.equal(c.invoke("send", jobId, "--end").status, 0);
  await c.finished(jobId);
  assert.ok(!fs.existsSync(socketPath), `${socketPath} outlived its job`);
});

for (const [sandbox, flags] of Object.entries(SANDBOX_FLAGS)) {
  for (const decision of Object.keys(DECISION_LINES)) {
    test(`a ${sandbox} task --steerable job runs under ${decision}${decision === "GO" ? " with no warning" : ", and the record and every send carry the warning"}`, { timeout: CLI_TIMEOUT_MS }, async t => {
      const c = cliFixture(t, { decision, lane: sandbox.includes("droid-lock.sh") });
      const { jobId, stderr } = c.launch(...flags);
      const record = await c.steerable(jobId);
      const warned = decision === "GO-WARN";
      assert.equal("steeringWarning" in record, warned, JSON.stringify(record.steeringWarning));
      if (warned) for (const name of UNSETTABLE) assert.match(record.steeringWarning, new RegExp(`ignores the requested[^;]*${name}.*session's[^;]*${name}`));
      const line = `warning: ${record.steeringWarning}`;
      assert.equal(stderr.includes("warning:"), warned, stderr);
      if (warned) assert.ok(stderr.includes(line), stderr);
      for (const args of [["hello"], ["--end"]]) {
        const sent = c.invoke("send", jobId, ...args);
        assert.equal(sent.status, 0, sent.stderr);
        assert.equal(sent.stdout, `sent to ${jobId}\n`);
        assert.equal(sent.stderr, warned ? `${line}\n` : "", args.join(" "));
      }
      const final = await c.finished(jobId);
      assert.equal(final.status, "completed", final.errorMessage);
      assert.equal(final.steeringWarning, record.steeringWarning);
      assert.ok(c.userTexts().includes("hello"));
    });
  }
}

test("a warning droid's transport reports is recorded on the finished job", { timeout: CLI_TIMEOUT_MS }, async t => {
  const c = cliFixture(t, { env: { FAKE_DROID_IGNORE_SETTINGS: "autonomyLevel,restrictToolIds" } });
  const { jobId } = c.launch();
  assert.ok(!("steeringWarning" in await c.steerable(jobId)));
  assert.equal(c.invoke("send", jobId, "--end").status, 0);
  const final = await c.finished(jobId);
  assert.equal(final.status, "completed", final.errorMessage);
  for (const name of ["autonomy", "tool list"]) assert.match(final.steeringWarning, new RegExp(`ignores the requested[^;]*${name}`));
  assert.ok(!c.withData(() => listJobs(c.cwd)).some(job => job.socketPath && fs.existsSync(job.socketPath)));
});
