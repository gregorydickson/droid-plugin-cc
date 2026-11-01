import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildDroidExecArgs, runDroidTurn } from "../plugins/droid/scripts/lib/droid.mjs";
import { makeTempDir } from "./helpers.mjs";
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
