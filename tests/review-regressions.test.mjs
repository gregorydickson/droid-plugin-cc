import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runDroidTurn, interruptDroidTurn, isQuotaError, createQuotaError, parseStructuredOutput } from "../plugins/droid/scripts/lib/droid.mjs";
import { makeTempDir, run, initGitRepo } from "./helpers.mjs";
import { installFakeDroid, buildEnv } from "./fake-droid-fixture.mjs";
const script = path.resolve("plugins/droid/scripts/droid-companion.mjs");
const hook = path.resolve("plugins/droid/scripts/stop-review-gate-hook.mjs");

test("stale or unverifiable PIDs never signal, and interruption never throws on EPERM", t => {
  const calls = [];
  t.mock.method(process, "kill", (...args) => { calls.push(args); throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  assert.equal(interruptDroidTurn(".", { turnId: `pid:${process.pid}` }).attempted, false);
  assert.equal(interruptDroidTurn(".", { turnId: `pid:${process.pid}:wrong-birth-time` }).attempted, false);
  assert.equal(interruptDroidTurn(".", null).attempted, false);
  assert.deepEqual(calls, []);
  const identity = "Sun Oct 11 12:00:00 2026 123";
  t.mock.method(childProcess, "spawnSync", () => ({ status: 0, stdout: identity, stderr: "" }));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = interruptDroidTurn(".", { turnId: `pid:${process.pid}:${Buffer.from(identity).toString("base64url")}` });
  assert.equal(result.interrupted, false);
  assert.match(result.detail, /denied/);
  assert.deepEqual(calls, [[-process.pid, "SIGKILL"], [process.pid, "SIGKILL"]]);
});
test("quota discrimination preserves retry metadata and excludes per-minute throttling", () => {
  for (const error of [{ message: "Quota exceeded for quota metric requests per minute", code: 429 }, { message: "quota configuration" }, { message: "notquota exhausted" }]) assert.equal(isQuotaError(error), false);
  for (const error of [{ code: "quota_exhausted" }, { message: "insufficient_quota" }, { message: "quota exhausted" }]) assert.equal(isQuotaError(error), true);
  assert.equal(createQuotaError({ data: { retryAfter: 42 } }).retryAfter, 42);
  assert.equal(createQuotaError({ retryAfter: 12 }).retryAfter, 12);
});
test("empty structured output preserves the failure cause and fallback overrides", () => {
  assert.equal(parseStructuredOutput("", { failureMessage: "Authentication failed" }).parseError, "Authentication failed");
  assert.equal(parseStructuredOutput("{}", { parsed: "fallback" }).parsed, "fallback");
});
for (const git of [false, true]) {
  test(`stop gate handles ${git ? "oversized prompts" : "non-git directories"}`, () => {
    const cwd = makeTempDir(), bin = makeTempDir();
    installFakeDroid(bin, "adversarial-clean");
    if (git) { initGitRepo(cwd); fs.writeFileSync(path.join(cwd, "a.txt"), "a\n"); run("git", ["add", "."], { cwd }); run("git", ["commit", "-m", "init"], { cwd }); }
    const env = buildEnv(bin);
    assert.equal(run("node", [script, "setup", "--enable-review-gate", "--json"], { cwd, env }).status, 0);
    const result = run("node", [hook], { cwd, env, input: JSON.stringify({ cwd, last_assistant_message: "x".repeat(1500000) }) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "");
  });
}
test("effort errors enumerate off and max; fanout is rejected by runtime resolution", () => {
  const cwd = makeTempDir();
  const effort = run("node", [script, "task", "--effort", "invalid", "hello"], { cwd });
  assert.match(effort.stderr, /off/); assert.match(effort.stderr, /max/);
  const fanout = run("node", [script, "task", "--fanout", "2", "hello"], { cwd });
  assert.match(fanout.stderr, /--fanout is not supported/);
});

for (const command of ["review", "adversarial-review", "stop"]) {
  for (const large of [false, true]) {
    test(`${command} self-collects beyond the ${large ? "byte" : "file"} threshold`, () => {
      const cwd = makeTempDir(), bin = makeTempDir();
      installFakeDroid(bin, "adversarial-clean"); initGitRepo(cwd);
      const names = large ? ["a.txt"] : ["a.txt", "b.txt", "c.txt"];
      for (const name of names) fs.writeFileSync(path.join(cwd, name), "before\n");
      run("git", ["add", "."], { cwd }); run("git", ["commit", "-m", "init"], { cwd });
      for (const name of names) fs.writeFileSync(path.join(cwd, name), "UNIQUE_DIFF_CONTENT".repeat(large ? 20000 : 1) + "\n");
      const env = buildEnv(bin);
      if (command === "stop") run("node", [script, "setup", "--enable-review-gate", "--json"], { cwd, env });
      const result = run("node", command === "stop" ? [hook] : [script, command, "--wait"], { cwd, env, input: JSON.stringify({ cwd }) });
      assert.equal(result.status, 0, result.stderr);
      const state = JSON.parse(fs.readFileSync(path.join(bin, "fake-droid-state.json")));
      assert.ok(!state.lastTurnStart.prompt.includes("UNIQUE_DIFF_CONTENT"));
      assert.match(state.lastTurnStart.prompt, /Inspect the target diff yourself with read-only git commands/);
    });
  }
}

test("transport and documentation retain platform, temp-file and permission contracts", () => {
  const source = fs.readFileSync(path.resolve("plugins/droid/scripts/lib/droid.mjs"), "utf8");
  assert.match(source, /shell: process.platform === "win32"/);
  assert.match(source, /createTempDir\("droid-prompt-"\)/);
  assert.doesNotMatch(source, /mkdtempSync|process\.kill/);
  assert.doesNotMatch(source, /options\.fanout/);
  const companion = fs.readFileSync(script, "utf8");
  assert.doesNotMatch(companion, /startWorkerControl|sendWorkerMessage|fanout < 1/);
  const rescue = fs.readFileSync(path.resolve("plugins/droid/agents/droid-rescue.md"), "utf8");
  assert.match(rescue, /not a filesystem sandbox/);
  assert.match(rescue, /forwarded prompt and check changedFiles/);
  for (const file of ["docs/droid-protocol.md", "plugins/droid/skills/droid-cli-runtime/SKILL.md"]) {
    const text = fs.readFileSync(path.resolve(file), "utf8");
    assert.match(text, /Read,LS,Grep,Glob,Execute/);
    assert.match(text, /insufficient permission to proceed/);
    assert.doesNotMatch(text, /autonomyLevel: low/);
  }
});

test("Windows turns launch cmd shims through the shell and remove their prompt file", async t => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => { Object.defineProperty(process, "platform", platform); t.mock.restoreAll(); syncBuiltinESMExports(); });
  let invocation;
  t.mock.method(childProcess, "spawnSync", () => ({ status: 0, stdout: "", stderr: "" }));
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    invocation = { command, args, options, prompt: fs.readFileSync(args[args.indexOf("-f") + 1], "utf8") };
    const child = Object.assign(new EventEmitter(), { pid: 1234, stdout: new PassThrough(), stderr: new PassThrough() });
    setImmediate(() => {
      for (const event of [
        { result: { sessionId: "windows-session" } },
        { method: "droid.session_notification", params: { notification: { type: "assistant_text_delta", messageId: "answer", blockIndex: 0, textDelta: "done" } } },
        { method: "droid.session_notification", params: { notification: { type: "agent_turn_completed", reason: "completed" } } }
      ]) child.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...event }) + "\n");
      child.stdout.end(); child.stderr.end(); child.emit("exit", 0); child.emit("close", 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  const result = await runDroidTurn(makeTempDir(), { prompt: "windows prompt", env: { DROID_BINARY: "droid.cmd" } });
  assert.equal(result.status, 0);
  assert.equal(invocation.command, "droid.cmd");
  assert.equal(invocation.options.shell, true);
  assert.equal(invocation.prompt, "windows prompt");
  assert.equal(fs.existsSync(invocation.args[invocation.args.indexOf("-f") + 1]), false);
});
