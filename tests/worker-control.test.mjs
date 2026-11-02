import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeDroid, buildEnv } from "./fake-droid-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const companion = path.resolve("plugins/droid/scripts/droid-companion.mjs");

function repo() {
  const cwd = fs.realpathSync(makeTempDir("droid-send-repo-"));
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "send\n");
  run("git", ["add", "."], { cwd }); run("git", ["commit", "-m", "initial"], { cwd });
  const bin = makeTempDir("droid-send-bin-");
  installFakeDroid(bin);
  return { cwd, env: { ...buildEnv(bin), CLAUDE_PLUGIN_DATA: makeTempDir("droid-send-data-"), DROID_STEER_IDLE_MS: "60000" } };
}

test("send resolves its target like the session commands and refuses an unknown one", () => {
  const { cwd, env } = repo();
  const result = run("node", [companion, "send", "unknown", "hi"], { cwd, env, timeout: 30000 });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "Unknown session: unknown");
  assert.equal(result.stdout, "");
});

test("send delivers to a running task --steerable job and reports the job it reached", { timeout: 120000 }, async () => {
  const { cwd, env } = repo();
  const launched = run("node", [companion, "task", "--steerable", "--background", "--json", "wait for me"], { cwd, env, timeout: 30000 });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  let sent;
  for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
    sent = run("node", [companion, "send", jobId, "--end"], { cwd, env, timeout: 30000 });
    // Until the worker records its socket the job reads as queued or socketless.
    if (sent.status === 0 || !/Job is not running\.|Steering socket is unavailable\./.test(sent.stderr)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(sent.stdout, `sent to ${jobId}\n`);
});
