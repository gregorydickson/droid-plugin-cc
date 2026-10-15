import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeDroid, SESSION_USAGE } from "./fake-droid-fixture.mjs";
import { sessionUsageFields } from "../plugins/droid/scripts/lib/tracked-jobs.mjs";
import { upsertJob } from "../plugins/droid/scripts/lib/state.mjs";
import { installWorkerDroid } from "./worker-droid-fixture.mjs";

const script = fileURLToPath(new URL("../plugins/droid/scripts/droid-companion.mjs", import.meta.url));
function setup(extraEnv = {}, { worker = true } = {}) {
  const root = makeTempDir(); initGitRepo(root);
  fs.writeFileSync(path.join(root, "source.txt"), "original\n");
  run("git", ["add", "."], { cwd: root }); run("git", ["commit", "-m", "initial"], { cwd: root });
  const bin = makeTempDir(); if (worker) installWorkerDroid(bin); else installFakeDroid(bin);
  const env = { ...buildEnv(bin), DROID_HOME: makeTempDir(), DROID_COMPANION_SESSION_ID: "model-tests", ...extraEnv };
  const schema = path.join(root, "schema.json");
  fs.writeFileSync(schema, JSON.stringify({ type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false }));
  const exec = (...args) => {
    const result = run(process.execPath, [script, ...args], { cwd: root, env });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  const cli = (...args) => JSON.parse(exec(...args, "--json"));
  const lastTurn = () => JSON.parse(fs.readFileSync(path.join(bin, "fake-droid-state.json"))).lastTurnStart;
  return { root, env, schema, exec, cli, lastTurn };
}
const [TURN1, TURN2] = SESSION_USAGE;
const minus = (total, prior) => Object.fromEntries(Object.keys(total).map(key => [key, total[key] - prior[key]]));
const usageLine = usage => `Usage: ${usage.inputTokens} in / ${usage.outputTokens} out tokens, ${usage.factoryCredits} credits`;
const escape = text => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const DEFAULTS = { DROID_DEFAULT_MODEL: "env-model", DROID_DEFAULT_EFFORT: "max" };

test("models lists parsed models as a table and as JSON", () => {
  const { exec, cli } = setup(DEFAULTS);
  const table = exec("models");
  assert.match(table, /CLI default model: gpt-6-sol/);
  assert.match(table, /Plugin defaults: model env-model, effort max/);
  assert.match(table, /\| claude-opus-5-5 \| Opus 5\.5 \| low, medium, high, xhigh, max \| medium \|/);
  const report = cli("models");
  assert.equal(report.defaultModel, "gpt-6-sol");
  assert.deepEqual(report.defaults, { model: "env-model", effort: "max" });
  assert.deepEqual(report.models.find(model => model.id === "auto"), { id: "auto", name: "Auto Model", deprecated: false, supportsReasoning: false, efforts: [], defaultEffort: null, isDefault: false });
});

test("DROID_DEFAULT_MODEL/EFFORT apply to task, worker and both reviews when flags are omitted", () => {
  const plain = setup(DEFAULTS, { worker: false });
  const workerFake = setup(DEFAULTS);
  fs.writeFileSync(path.join(plain.root, "source.txt"), "changed\n");
  const runs = {
    task: [plain, () => plain.cli("task", "Diagnose the failing test")],
    review: [plain, () => plain.cli("review", "--scope", "working-tree")],
    "adversarial-review": [plain, () => plain.cli("adversarial-review", "--scope", "working-tree")],
    worker: [workerFake, () => workerFake.cli("task", "--output-schema", workerFake.schema, "Count rows")]
  };
  for (const [name, [fixture, launch]] of Object.entries(runs)) {
    const payload = launch();
    assert.deepEqual({ model: fixture.lastTurn().model, effort: fixture.lastTurn().effort }, { model: "env-model", effort: "max" }, name);
    if (name === "worker") assert.deepEqual({ model: payload.job.model, effort: payload.job.effort }, { model: "env-model", effort: "max" });
  }
});

test("explicit flags beat the env defaults, and no env means no -m/-r", () => {
  const withEnv = setup(DEFAULTS);
  withEnv.cli("task", "--model", "flag-model", "--effort", "low", "Count rows");
  assert.deepEqual({ model: withEnv.lastTurn().model, effort: withEnv.lastTurn().effort }, { model: "flag-model", effort: "low" });
  withEnv.cli("task", "--effort", "high", "Count rows");
  assert.deepEqual({ model: withEnv.lastTurn().model, effort: withEnv.lastTurn().effort }, { model: "env-model", effort: "high" });
  const bare = setup();
  bare.cli("task", "Count rows");
  assert.deepEqual({ model: bare.lastTurn().model, effort: bare.lastTurn().effort }, { model: null, effort: null });
});

test("a resumed session keeps its stored model rather than the env default", () => {
  const first = setup({ DROID_DEFAULT_MODEL: "first-model" });
  first.cli("task", "--name", "keeper", "Start task");
  first.env.DROID_DEFAULT_MODEL = "later-model";
  first.cli("sessions", "resume", "keeper", "Continue task");
  assert.equal(first.lastTurn().model, "first-model");
  first.cli("sessions", "resume", "keeper", "--model", "override-model", "Again");
  assert.equal(first.lastTurn().model, "override-model");
});

test("setup shows the effective defaults", () => {
  const { exec, cli } = setup(DEFAULTS);
  assert.deepEqual(cli("setup").defaults, { model: "env-model", effort: "max" });
  const text = exec("setup");
  assert.match(text, /- default model: env-model \(DROID_DEFAULT_MODEL\)/);
  assert.match(text, /- default effort: max \(DROID_DEFAULT_EFFORT\)/);
  assert.match(setup().exec("setup"), /- default model: CLI default\n- default effort: model default/);
});

test("result and status render the job's tokens and credits", () => {
  const { exec, cli } = setup();
  cli("task", "Count rows");
  const jobId = cli("status").latestFinished.id;
  assert.match(exec("result", jobId), new RegExp(`${escape(usageLine(TURN1))}\n$`));
  assert.deepEqual(cli("status", jobId).job.usage, TURN1);
  const status = exec("status");
  assert.match(status, new RegExp(escape(usageLine(TURN1))));
  assert.match(status, new RegExp(`Total credits: ${TURN1.factoryCredits} across 1 listed job with usage`));
});

test("a resumed job reports only its own share of the session-inclusive usage", () => {
  const { exec, cli } = setup();
  cli("task", "--name", "metered", "Start task");
  const originalId = cli("status").latestFinished.id;
  cli("sessions", "resume", "metered", "Continue task");
  const resumedId = cli("status").latestFinished.id;
  assert.notEqual(resumedId, originalId);
  const own = minus(TURN2, TURN1);
  assert.deepEqual(cli("status", resumedId).job.usage, own);
  assert.equal(cli("result", resumedId).usage.factoryCredits, TURN2.factoryCredits - TURN1.factoryCredits);
  assert.deepEqual(cli("status", originalId).job.usage, TURN1);
  assert.match(exec("result", resumedId), new RegExp(`${escape(usageLine(own))}\n$`));
  assert.match(exec("status", "--all"), new RegExp(`Total credits: ${TURN2.factoryCredits} across`), "per-job credits across the session add up to the session total");
});

test("an answered job keeps both of its turns, since its only prior record is itself", () => {
  const { cli } = setup();
  const question = cli("task", "--name", "asker", "--pause-and-ask", "NEED_ANSWER");
  assert.equal(question.status, "awaiting-answer");
  assert.deepEqual(cli("status", question.jobId).job.usage, TURN1);
  cli("answer", question.jobId, "yes");
  assert.deepEqual(cli("status", question.jobId).job.usage, TURN2);
});

test("a resumed turn that pauses reports its own share while awaiting an answer", () => {
  const { cli } = setup();
  cli("task", "--name", "pauser", "Start task");
  const paused = cli("sessions", "resume", "pauser", "--pause-and-ask", "NEED_ANSWER");
  assert.equal(paused.status, "awaiting-answer");
  assert.deepEqual(cli("status", paused.jobId).job.usage, minus(TURN2, TURN1));
});

test("session usage with no prior record is the job's own usage; a legacy prior record subtracts its usage", () => {
  const workspace = makeTempDir();
  assert.deepEqual(sessionUsageFields(workspace, "task-new", "thr-x", TURN2), { sessionUsage: TURN2, usage: TURN2 });
  assert.deepEqual(sessionUsageFields(workspace, "task-new", null, TURN2), { sessionUsage: TURN2, usage: TURN2 });
  assert.deepEqual(sessionUsageFields(workspace, "task-new", "thr-x", null), { sessionUsage: null, usage: null });
  upsertJob(workspace, { id: "task-self", threadId: "thr-self", status: "awaiting-answer", sessionUsage: TURN1, usage: TURN1 });
  assert.deepEqual(sessionUsageFields(workspace, "task-self", "thr-self", TURN2).usage, TURN2, "a job's own earlier segment is never its prior");
  upsertJob(workspace, { id: "task-other", threadId: "thr-other", status: "completed", sessionUsage: TURN1, usage: TURN1, completedAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(sessionUsageFields(workspace, "task-new", "thr-x", TURN2).usage, TURN2, "another session's record is not a prior");
  upsertJob(workspace, { id: "task-legacy", threadId: "thr-x", status: "completed", usage: TURN1, completedAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(sessionUsageFields(workspace, "task-new", "thr-x", TURN2).usage, minus(TURN2, TURN1));
  upsertJob(workspace, { id: "task-later", threadId: "thr-x", status: "completed", sessionUsage: TURN2, usage: minus(TURN2, TURN1), completedAt: "2026-01-02T00:00:00.000Z" });
  const third = Object.fromEntries(Object.keys(TURN2).map(key => [key, TURN2[key] + 1]));
  assert.deepEqual(sessionUsageFields(workspace, "task-new", "thr-x", third).usage, minus(third, TURN2), "the latest prior record is subtracted");
  assert.deepEqual(sessionUsageFields(workspace, "task-new", "thr-x", TURN1).usage, Object.fromEntries(Object.keys(TURN1).map(key => [key, 0])), "a smaller total clamps at zero");
});
