import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir } from "./helpers.mjs";
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
  return { cwd, env, state, requests, userTexts };
}

async function untilSent(f, text) {
  while (!f.userTexts().includes(text)) await new Promise(resolve => setTimeout(resolve, 20));
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

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
