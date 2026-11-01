import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run, smokeEnv, SMOKE_MODEL } from "./helpers.mjs";
import { READ_ONLY_TOOLS, WEB_TOOLS } from "../plugins/droid/scripts/lib/droid.mjs";
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

const live = { skip: process.env.DROID_SMOKE !== "1" };

function companion(cwd, env, args, timeout) {
  return spawnSync(process.execPath, [script.pathname, ...args], { cwd, env, encoding: "utf8", timeout });
}

function listTools(model, tools) {
  return run("droid", ["exec", "-m", model, "--only-tools", tools.join(","), "--list-tools", "--output-format", "json"], { env: process.env, timeout: 50000 });
}

function filesUnder(dir, suffix) {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(suffix))
    .map(entry => path.join(entry.parentPath, entry.name));
}

function jobRecords(dataRoot) {
  const found = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) {
        try { const parsed = JSON.parse(fs.readFileSync(full, "utf8")); found.push(parsed, ...(Array.isArray(parsed.jobs) ? parsed.jobs : [])); } catch { /* not a job file */ }
      }
    }
  };
  walk(dataRoot);
  return found.filter(record => record && typeof record === "object" && record.id && "model" in record);
}

for (const model of ["glm-5.3", "gpt-6.1-sol"]) {
  test(`real Droid accepts every read-only tool id for ${model} and rejects an unknown one`, { ...live, timeout: 120000 }, () => {
    const accepted = listTools(model, READ_ONLY_TOOLS);
    assert.equal(accepted.status, 0, accepted.error?.message || accepted.stderr);
    const rejected = listTools(model, [...READ_ONLY_TOOLS, "NotATool"]);
    assert.notEqual(rejected.status, 0, rejected.stdout);
    assert.match(rejected.stderr, /Unknown tool identifier/);
  });
}

test("a read-only job runs git log and a web search", { ...live, timeout: 180000 }, () => {
  const cwd = makeTempDir();
  run("git", ["init", "-b", "main", "--separate-git-dir", path.join(makeTempDir("droid-smoke-gitdir-"), "repo.git")], { cwd });
  run("git", ["config", "user.name", "Droid Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
  run("git", ["add", "."], { cwd }); run("git", ["commit", "-m", "init"], { cwd });
  const head = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  const env = smokeEnv();
  const result = companion(cwd, env, ["task", "--model", SMOKE_MODEL, "--json", "Run `git log -1 --format=%H` and do one web search for the Node.js release schedule; report the hash and one URL."], 170000);
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, 0);
  assert.ok(envelope.rawOutput.includes(head), envelope.rawOutput);
  assert.match(envelope.rawOutput, /https?:\/\//);
  const toolsRun = filesUnder(env.CLAUDE_PLUGIN_DATA, ".log").flatMap(file => [...fs.readFileSync(file, "utf8").matchAll(/Running tool: (\w+)/g)].map(match => match[1]));
  assert.ok(toolsRun.some(tool => WEB_TOOLS.includes(tool)), `no web tool ran; tools run: ${toolsRun.join(",")}`);
});

test("a fenced task with no --model uses the default set from another workspace", { ...live, timeout: 180000 }, () => {
  const env = smokeEnv({ fenced: true });
  const workspaceA = makeTempDir(); initGitRepo(workspaceA);
  const workspaceB = makeTempDir(); initGitRepo(workspaceB);
  const setup = companion(workspaceA, env, ["setup", "--default-model", "glm-5.3", "--default-effort", "high", "--json"], 30000);
  assert.equal(setup.status, 0, setup.error?.message || setup.stderr);
  const result = companion(workspaceB, env, ["task", "--json", "Reply with the single word ok. Do not use tools."], 150000);
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const job = jobRecords(env.CLAUDE_PLUGIN_DATA).find(record => record.model);
  assert.ok(job, "no job record with a model was written");
  assert.equal(job.model, "glm-5.3");
});
