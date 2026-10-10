import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo } from "./helpers.mjs";
const script = new URL("../plugins/droid/scripts/droid-companion.mjs", import.meta.url);
test("real Droid completes a trivial read-only structured worker", { skip: process.env.DROID_SMOKE !== "1", timeout: 120000 }, () => {
  const cwd = makeTempDir(); initGitRepo(cwd);
  const schema = path.join(cwd, "smoke-schema.json");
  fs.writeFileSync(schema, JSON.stringify({ type: "object", required: ["ok"], additionalProperties: false, properties: { ok: { const: true } } }));
  const result = spawnSync(process.execPath, [script.pathname, "task", "--output-schema", schema, "--json", "Return {\"ok\":true}. Do not use tools."], {
    cwd, encoding: "utf8", timeout: 110000, env: { ...process.env, CLAUDE_PLUGIN_DATA: makeTempDir("droid-smoke-data-") }
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, "completed"); assert.equal(envelope.schemaValid, true);
  assert.deepEqual(envelope.result, { ok: true }); assert.ok(envelope.threadId);
  assert.deepEqual(envelope.changedFiles, []);
});
