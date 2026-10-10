import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runDroidTurn, buildPauseOutputSchema } from "../plugins/droid/scripts/lib/droid.mjs";
import { resolveRuntimeOptions } from "../plugins/droid/scripts/lib/runtime-options.mjs";
import { makeTempDir } from "./helpers.mjs";
import { installWorkerDroid } from "./worker-droid-fixture.mjs";
import { buildEnv } from "./fake-droid-fixture.mjs";
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
  assert.deepEqual(first.usage, { inputTokens: 10, outputTokens: 2 });
  assert.ok(progress.some(event => event.threadId === first.threadId));
  const initialArgs = state().threadRequests[0].args;
  assert.ok(!initialArgs.includes("--auto"));
  assert.equal(initialArgs[initialArgs.indexOf("--only-tools") + 1], "Read,LS,Grep,Glob");
  assert.equal(initialArgs[initialArgs.indexOf("-m") + 1], "factory-model");
  assert.equal(initialArgs[initialArgs.indexOf("-r") + 1], "max");
  const resumed = await runDroidTurn(makeTempDir(), { prompt: "Continue", resumeThreadId: first.threadId, sandbox: "workspace-write" });
  assert.equal(resumed.threadId, first.threadId);
  const args = state().threadRequests.at(-1).args;
  assert.equal(args[args.indexOf("--session-id") + 1], first.threadId);
  assert.equal(args[args.indexOf("--auto") + 1], "medium");
});
test("schema repair resumes once read-only and includes both turns' usage", async t => {
  const state = fixture(t, "repair-once");
  const result = await runDroidTurn(makeTempDir(), { prompt: "Count", outputSchema: schema, sandbox: "workspace-write" });
  assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.finalMessage), { count: 2 });
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 4 });
  const requests = state().threadRequests;
  assert.deepEqual(requests.map(r => r.threadId), [result.threadId, result.threadId]);
  assert.ok(!requests[1].args.includes("--auto"));
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

const collaboration = (receivers, threadId = "thread", turnId = "turn") => ({ method: "item/completed", params: { threadId, turnId, item: { type: "collabAgentToolCall", id: `spawn-${receivers.join("-")}`, tool: "spawnAgent", status: "completed", receiverThreadIds: receivers } } });
const childStarted = id => ({ method: "turn/started", params: { threadId: id, turn: { id: `turn-${id}`, status: "inProgress" } } });
const childResult = id => ({ method: "item/completed", params: { threadId: id, turnId: `turn-${id}`, item: { type: "agentMessage", text: `result-${id}`, phase: "final_answer" } } });
const childCompleted = id => ({ method: "turn/completed", params: { threadId: id, turn: { id: `turn-${id}`, status: "completed" } } });
function completedPair() {
  return [collaboration(["a", "b"]), childStarted("a"), childResult("a"), childCompleted("a"), childStarted("b"), childResult("b"), childCompleted("b")];
}
