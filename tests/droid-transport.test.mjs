import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runDroidTurn, buildDroidExecArgs, buildPauseOutputSchema, READ_ONLY_TOOLS, REPAIR_TOOLS, JOB_KINDS } from "../plugins/droid/scripts/lib/droid.mjs";
import { resolveRuntimeOptions } from "../plugins/droid/scripts/lib/runtime-options.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveJobsDir } from "../plugins/droid/scripts/lib/state.mjs";
import { installWorkerDroid } from "./worker-droid-fixture.mjs";
import { buildEnv, installFakeDroid, SESSION_USAGE } from "./fake-droid-fixture.mjs";

const COMPANION = path.resolve(import.meta.dirname, "../plugins/droid/scripts/droid-companion.mjs");
const schema = { type: "object", required: ["count"], additionalProperties: false, properties: { count: { type: "integer" } } };
function fixture(t, behavior) {
  const bin = makeTempDir(); installWorkerDroid(bin, behavior);
  const old = process.env.DROID_BINARY;
  process.env.DROID_BINARY = buildEnv(bin).DROID_BINARY;
  t.after(() => { if (old === undefined) delete process.env.DROID_BINARY; else process.env.DROID_BINARY = old; });
  return () => JSON.parse(fs.readFileSync(path.join(bin, "fake-droid-state.json")));
}
test("Droid streams progress, returns usage, maps controls, and resumes its session", async t => {
  const state = fixture(t);
  const progress = [];
  const first = await runDroidTurn(makeTempDir(), { prompt: "Count", outputSchema: schema, model: "factory-model", effort: "max", onProgress: event => progress.push(event) });
  assert.equal(first.status, 0); assert.deepEqual(JSON.parse(first.finalMessage), { count: 2 });
  assert.deepEqual(first.usage, SESSION_USAGE[0]);
  assert.ok(progress.some(event => event.threadId === first.threadId));
  const initialArgs = state().threadRequests[0].args;
  assert.ok(!initialArgs.includes("--auto"));
  assert.deepEqual(new Set(initialArgs[initialArgs.indexOf("--only-tools") + 1].split(",")), new Set(READ_ONLY_TOOLS));
  assert.equal(initialArgs[initialArgs.indexOf("-m") + 1], "factory-model");
  assert.equal(initialArgs[initialArgs.indexOf("-r") + 1], "max");
  const resumed = await runDroidTurn(makeTempDir(), { prompt: "Continue", resumeThreadId: first.threadId, sandbox: "workspace-write" });
  assert.equal(resumed.threadId, first.threadId);
  assert.deepEqual(resumed.usage, SESSION_USAGE[1], "a continued turn reports the session-inclusive total");
  const args = state().threadRequests.at(-1).args;
  assert.equal(args[args.indexOf("--session-id") + 1], first.threadId);
  assert.equal(args[args.indexOf("--auto") + 1], "medium");
});
test("a one-shot turn logs each tool once by its use id, including the tools a code-mode Script runs", async t => {
  fixture(t, "code-mode-tools");
  const progress = [];
  const result = await runDroidTurn(makeTempDir(), { prompt: "Count", onProgress: event => progress.push(event.message) });
  assert.equal(result.status, 0, JSON.stringify(result.error));
  assert.deepEqual(progress.filter(message => message.startsWith("Running tool: ")), ["Script", "Execute", "WebSearch"].map(tool => `Running tool: ${tool}`));
});
test("schema repair takes the repair turn's session-inclusive usage, not a sum", async t => {
  const state = fixture(t, "repair-once");
  const result = await runDroidTurn(makeTempDir(), { prompt: "Count", outputSchema: schema, sandbox: "workspace-write" });
  assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.finalMessage), { count: 2 });
  assert.deepEqual(result.usage, SESSION_USAGE[1]);
  const requests = state().threadRequests;
  assert.deepEqual(requests.map(r => r.threadId), [result.threadId, result.threadId]);
  assert.ok(!requests[1].args.includes("--auto"));
  assert.deepEqual(new Set(requests[1].args[requests[1].args.indexOf("--only-tools") + 1].split(",")), new Set(REPAIR_TOOLS));
});
test("invalid output after one repair retains raw text and fails", async t => {
  const state = fixture(t, "invalid-json");
  const result = await runDroidTurn(makeTempDir(), { prompt: "Count", outputSchema: schema });
  assert.equal(result.status, 1); assert.equal(result.finalMessage, "not valid json");
  assert.match(result.error.message, /after one repair/);
  assert.deepEqual(state().threadRequests.map(r => r.method), ["start", "resume"]);
});
for (const behavior of ["auth-run-fails", "malformed", "no-completion"]) {
  test(`Droid fails closed on ${behavior}`, async t => {
    fixture(t, behavior);
    const result = await runDroidTurn(makeTempDir(), { prompt: "Count", timeoutMs: 3000 });
    assert.equal(result.status, 1); assert.ok(result.error?.message);
  });
}
test("unsupported enforcement controls are rejected", () => {
  for (const key of ["profile", "mcpConfig", "fanout"]) assert.throws(() => resolveRuntimeOptions(".", { [key]: "requested" }), /not supported/);
});
test("pause schema preserves local references and refuses external scopes", () => {
  assert.equal(buildPauseOutputSchema({ $defs: { value: { type: "string" } }, $ref: "#/$defs/value" }).properties.result.anyOf[0].$ref, "#/properties/result/anyOf/0/$defs/value");
  assert.throws(() => buildPauseOutputSchema({ $ref: "https://example.com/schema" }), /local JSON-pointer/);
});
test("false schemas are enforced rather than treated as absent", async t => {
  const state = fixture(t);
  const result = await runDroidTurn(makeTempDir(), { prompt: "Count", outputSchema: false });
  assert.equal(result.status, 1);
  assert.match(result.error.message, /schema validation/);
  assert.deepEqual(state().threadRequests.map(r => r.method), ["start", "resume"]);
});

test("pause schema rejects unsafe reference scopes and preserves literal data with schema-looking keys", () => {
  assert.throws(() => buildPauseOutputSchema({ $ref: "https://example.com/schema" }), /local JSON-pointer/);
  assert.throws(() => buildPauseOutputSchema({ $id: "https://example.com/schema", type: "object" }), /cannot safely wrap/);
  const schema = { type: "object", properties: { $id: { type: "string" }, value: { const: { $ref: "literal" } } } };
  assert.deepEqual(buildPauseOutputSchema(schema).properties.result.anyOf[0], schema);
});

test("progress emits assembled messages and callback failures do not abort the turn", async t => {
  fixture(t);
  const output = [];
  const result = await runDroidTurn(makeTempDir(), { prompt: "Count", onProgress(event) {
    if (event.logBody) output.push(event.logBody);
    throw new Error("lock timeout");
  } });
  assert.equal(result.status, 0);
  assert.deepEqual(output, ['{"count":2}']);
  assert.ok(result.warnings.some(w => /lock timeout/.test(w.message)));
});
test("a completed assistant message is reported before the turn ends", async t => {
  fixture(t, "text-then-hang");
  const output = [];
  const result = await runDroidTurn(makeTempDir(), { prompt: "Count", timeoutMs: 1500, onProgress(event) {
    if (event.logBody) output.push(event.logBody);
  } });
  assert.notEqual(result.status, 0);
  assert.deepEqual(output, ['{"count":2}']);
});
for (const behavior of ["warning-success", "blank-lines", "trailing-prose"]) {
  test(`terminal success tolerates ${behavior}`, async t => {
    fixture(t, behavior);
    const result = await runDroidTurn(makeTempDir(), { prompt: "Count" });
    assert.equal(result.status, 0);
    assert.equal(result.finalMessage, '{"count":2}');
    if (behavior === "warning-success") assert.ok(result.warnings.some(w => w.message === "Temporary model error"));
  });
}

test("turn timeout is opt-in", async t => {
  fixture(t, "slow-task");
  const original = globalThis.setTimeout;
  const delays = [];
  t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) => { delays.push(delay); return original(fn, delay, ...args); });
  assert.equal((await runDroidTurn(makeTempDir(), { prompt: "Count" })).status, 0);
  assert.deepEqual(delays, []);
  const timed = await runDroidTurn(makeTempDir(), { prompt: "Count", timeoutMs: 10 });
  assert.equal(timed.status, 1);
  assert.match(timed.error.message, /timed out/);
  assert.deepEqual(delays, [10]);
});

test("asynchronous progress rejection remains a warning", async t => {
  fixture(t);
  const result = await runDroidTurn(makeTempDir(), { prompt: "Count", onProgress: async () => { throw new Error("async lock timeout"); } });
  assert.equal(result.status, 0);
  assert.ok(result.warnings.some(w => /async lock timeout/.test(w.message)));
});

const FLAG = "--append-system-prompt-file";
const flagPath = args => args[args.indexOf(FLAG) + 1];

test("developer instructions travel in the system prompt file, not the prompt, and the temp dir is removed", async t => {
  const state = fixture(t);
  const text = "Always answer in haiku.";
  const result = await runDroidTurn(makeTempDir(), { prompt: "Count", developerInstructions: text });
  assert.equal(result.status, 0);
  const { args } = state().threadRequests[0];
  assert.ok(args.includes(FLAG));
  assert.equal(path.basename(flagPath(args)), "system-prompt.txt");
  assert.equal(state().lastTurnStart.systemPrompt, text);
  assert.ok(!state().lastTurnStart.prompt.includes(text));
  assert.ok(!fs.existsSync(path.dirname(flagPath(args))));
});

test("a schema repair turn never carries the system prompt flag", async t => {
  const state = fixture(t, "repair-once");
  const text = "Always answer in haiku.";
  const result = await runDroidTurn(makeTempDir(), { prompt: "Count", outputSchema: schema, developerInstructions: text });
  assert.equal(result.status, 0);
  const [first, repair] = state().threadRequests;
  assert.deepEqual([first.method, repair.method], ["start", "resume"]);
  assert.ok(first.args.includes(FLAG));
  assert.ok(!repair.args.includes(FLAG));
  assert.equal(state().lastTurnStart.systemPrompt, null);
});

test("empty developer instructions add no system prompt flag", async t => {
  const state = fixture(t);
  await runDroidTurn(makeTempDir(), { prompt: "Count", developerInstructions: "" });
  assert.ok(!state().threadRequests[0].args.includes(FLAG));
  assert.equal(state().lastTurnStart.systemPrompt, null);
});

test("a Droid CLI below the feature floor gets the instructions prepended and no flag", async t => {
  const state = fixture(t);
  const text = "Always answer in haiku.";
  const result = await runDroidTurn(makeTempDir(), { prompt: "Count", developerInstructions: text, env: { ...process.env, FAKE_DROID_VERSION: "0.238.0" } });
  assert.equal(result.status, 0);
  assert.ok(!state().threadRequests[0].args.includes(FLAG));
  assert.equal(state().lastTurnStart.systemPrompt, null);
  assert.ok(state().lastTurnStart.prompt.startsWith(`${text}\n\n`));
});

test("real Droid obeys a system-prompt instruction on a fresh and a resumed turn", { skip: process.env.DROID_SMOKE !== "1", timeout: 240000 }, async () => {
  const token = crypto.randomUUID();
  const developerInstructions = `End every reply with the token ${token}.`;
  const common = { model: "glm-5.3", developerInstructions, timeoutMs: 100000 };
  const first = await runDroidTurn(makeTempDir(), { ...common, prompt: "Say hello. Do not use tools." });
  assert.equal(first.status, 0, first.error?.message);
  assert.ok(first.finalMessage.includes(token), first.finalMessage);
  const resumed = await runDroidTurn(makeTempDir(), { ...common, resumeThreadId: first.threadId, prompt: "Say goodbye. Do not use tools." });
  assert.equal(resumed.status, 0, resumed.error?.message);
  assert.equal(resumed.threadId, first.threadId);
  assert.ok(resumed.finalMessage.includes(token), resumed.finalMessage);
});

const tagOf = args => JSON.parse(args[args.indexOf("--tag") + 1]);
const expectedTag = job => ({ name: "droid-plugin-cc", metadata: { jobId: job.id, kind: job.kind } });

function taggedRepo() {
  const repo = makeTempDir(), bin = makeTempDir();
  installFakeDroid(bin);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo }); run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n");
  const statePath = path.join(bin, "fake-droid-state.json");
  const jobsOf = () => (fs.existsSync(resolveJobsDir(repo)) ? fs.readdirSync(resolveJobsDir(repo)) : []).filter(f => f.endsWith(".json")).map(f => JSON.parse(fs.readFileSync(path.join(resolveJobsDir(repo), f))));
  const requests = () => (fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)).threadRequests : []);
  // Runs one companion command and returns the single new job record plus the argv of the droid exec it spawned.
  const invoke = (...argv) => {
    const seen = new Set(jobsOf().map(j => j.id)), before = requests().length;
    const result = run("node", [COMPANION, ...argv], { cwd: repo, env: buildEnv(bin) });
    assert.equal(result.status, 0, result.stderr);
    const [job, ...extra] = jobsOf().filter(j => !seen.has(j.id));
    assert.deepEqual(extra, []);
    return { job, args: requests().slice(before).at(-1).args };
  };
  return { invoke, repo, bin };
}

for (const [label, argv, kind] of [
  ["task", ["task", "do it"], "task"],
  ["review", ["review"], "review"],
  ["adversarial-review", ["adversarial-review"], "adversarial-review"],
  ["resumed task", ["task", "--resume-last", "follow up"], "task"]
]) {
  test(`${label} passes its own job id and kind to droid as --tag`, () => {
    const { invoke } = taggedRepo();
    if (label === "resumed task") invoke("task", "first");
    const { job, args } = invoke(...argv);
    assert.equal(job.kind, kind);
    assert.ok(JOB_KINDS.includes(job.kind));
    assert.deepEqual(tagOf(args), expectedTag(job));
  });
}

test("a schema repair turn carries the same tag as the turn it repairs", async t => {
  const state = fixture(t, "repair-once");
  const tag = { jobId: "task-abc", kind: "task" };
  await runDroidTurn(makeTempDir(), { prompt: "Count", outputSchema: schema, tag });
  const requests = state().threadRequests;
  assert.deepEqual(requests.map(r => r.method), ["start", "resume"]);
  for (const request of requests) assert.deepEqual(tagOf(request.args), { name: "droid-plugin-cc", metadata: tag });
});

test("a Droid CLI below the feature floor gets no --tag", async t => {
  const state = fixture(t);
  await runDroidTurn(makeTempDir(), { prompt: "Count", tag: { jobId: "task-abc", kind: "task" }, env: { ...process.env, FAKE_DROID_VERSION: "0.238.0" } });
  assert.ok(!state().threadRequests[0].args.includes("--tag"));
});

test("a steerable turn and an untagged turn get no --tag", async t => {
  const state = fixture(t);
  await runDroidTurn(makeTempDir(), { prompt: "Count" });
  assert.ok(!state().threadRequests[0].args.includes("--tag"));
  assert.ok(!buildDroidExecArgs("/x", "/f", { tag: { jobId: "task-abc", kind: "task" }, steerable: true }).includes("--tag"));
});

test("an unknown job kind throws before spawn", async t => {
  fixture(t);
  assert.throws(() => buildDroidExecArgs("/x", "/f", { tag: { jobId: "task-abc", kind: "rescue" } }), /Unknown job kind "rescue"/);
  await assert.rejects(runDroidTurn(makeTempDir(), { prompt: "Count", tag: { jobId: "task-abc", kind: "rescue" } }), /Unknown job kind/);
  assert.ok(!fs.existsSync(path.join(path.dirname(process.env.DROID_BINARY), "fake-droid-state.json")), "droid was never spawned");
});

const SPEC_FLAGS = ["--use-spec", "--spec-model", "--spec-reasoning-effort"];
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

test("task --spec maps to Droid spec mode and a plain task spawns none of its flags", () => {
  const { invoke } = taggedRepo();
  const { args } = invoke("task", "--spec", "--spec-model", "glm-5.3", "--spec-effort", "high", "plan it");
  assert.ok(args.includes("--use-spec"));
  assert.equal(flagValue(args, "--spec-model"), "glm-5.3");
  assert.equal(flagValue(args, "--spec-reasoning-effort"), "high");
  const plain = invoke("task", "plan it").args;
  for (const flag of SPEC_FLAGS) assert.ok(!plain.includes(flag), flag);
});

test("task --spec alone passes only --use-spec, and an invalid spec effort is rejected", () => {
  const { invoke, repo, bin } = taggedRepo();
  const { args } = invoke("task", "--spec", "plan it");
  assert.ok(args.includes("--use-spec"));
  assert.ok(!args.includes("--spec-model") && !args.includes("--spec-reasoning-effort"));
  const bad = run("node", [COMPANION, "task", "--spec", "--spec-effort", "loud", "plan it"], { cwd: repo, env: buildEnv(bin) });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unsupported reasoning effort "loud"/);
});

test("a schema repair turn never carries the spec flags", async t => {
  const state = fixture(t, "repair-once");
  await runDroidTurn(makeTempDir(), { prompt: "Count", outputSchema: schema, spec: true, specModel: "glm-5.3", specEffort: "high" });
  const [first, repair] = state().threadRequests;
  assert.deepEqual([first.method, repair.method], ["start", "resume"]);
  for (const flag of SPEC_FLAGS) { assert.ok(first.args.includes(flag), flag); assert.ok(!repair.args.includes(flag), flag); }
});

test("resuming a spec job, by --resume-last or sessions resume, replays none of the spec flags", () => {
  const { invoke } = taggedRepo();
  invoke("task", "--spec", "--spec-model", "glm-5.3", "--spec-effort", "high", "--name", "specjob", "plan it");
  const sessionResume = invoke("sessions", "resume", "specjob", "follow up").args;
  for (const flag of SPEC_FLAGS) assert.ok(!sessionResume.includes(flag), flag);
  const last = invoke("task", "--spec", "--spec-model", "glm-5.3", "plan again");
  assert.ok(last.args.includes("--use-spec"));
  const lastResume = invoke("task", "--resume-last", "--spec", "--spec-model", "glm-5.3", "follow up").args;
  for (const flag of SPEC_FLAGS) assert.ok(!lastResume.includes(flag), flag);
});

test("task --spec --json has the same top-level keys as task --json", () => {
  const { repo, bin } = taggedRepo();
  const keys = (...argv) => {
    const result = run("node", [COMPANION, "task", ...argv, "--json", "plan it"], { cwd: repo, env: buildEnv(bin) });
    assert.equal(result.status, 0, result.stderr);
    return Object.keys(JSON.parse(result.stdout)).sort();
  };
  assert.deepEqual(keys("--spec", "--spec-model", "glm-5.3"), keys());
});

test("--spec-model and --spec-effort require --spec, and --spec honours the Droid version floor", () => {
  const { repo, bin } = taggedRepo();
  const exec = (argv, env = {}) => run("node", [COMPANION, "task", ...argv, "plan it"], { cwd: repo, env: { ...buildEnv(bin), ...env } });
  for (const argv of [["--spec-model", "glm-5.3"], ["--spec-effort", "high"]]) {
    const result = exec(argv);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--spec-model and --spec-effort require --spec\./);
  }
  const old = exec(["--spec"], { FAKE_DROID_VERSION: "0.238.0" });
  assert.equal(old.status, 1);
  assert.match(old.stderr, /requires Droid CLI >= 1\.1\.0 \(found 0\.238\.0\)/);
});

test("--resume-last --spec onto a legacy job record without a stored request still sends no spec flags", () => {
  const { invoke, repo } = taggedRepo();
  const { job } = invoke("task", "first");
  const file = path.join(resolveJobsDir(repo), `${job.id}.json`);
  const { request, ...legacy } = JSON.parse(fs.readFileSync(file));
  assert.ok(request, "the record had a request to strip");
  fs.writeFileSync(file, JSON.stringify(legacy));
  const { args } = invoke("task", "--resume-last", "--spec", "--spec-model", "glm-5.3", "follow up");
  for (const flag of SPEC_FLAGS) assert.ok(!args.includes(flag), flag);
});
