import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeDroid } from "./fake-droid-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { buildDroidExecArgs, normalizeMcpToolSelector, READ_ONLY_TOOLS } from "../plugins/droid/scripts/lib/droid.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "droid", "scripts", "droid-companion.mjs");
const FILE_EDITING_TOOLS = ["Edit", "Create", "ApplyPatch", "MultiEdit", "Write"];

const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const toolList = (args, name) => flag(args, name)?.split(",");

test("run-commands builds medium autonomy over the read-only toolset on fresh and resumed turns", () => {
  for (const resumeThreadId of [undefined, "session-1"]) {
    const args = buildDroidExecArgs("/repo", "/p.txt", { sandbox: "run-commands", resumeThreadId });
    assert.equal(flag(args, "--auto"), "medium", String(resumeThreadId));
    assert.deepEqual(toolList(args, "--only-tools"), READ_ONLY_TOOLS);
    assert.equal(flag(args, "--output-format"), resumeThreadId ? "stream-json" : "stream-jsonrpc");
    // Flags configure only a one-shot exec; an --input-format JSON-RPC session would ignore them.
    assert.ok(!args.includes("--input-format"));
    for (const tool of FILE_EDITING_TOOLS) assert.ok(!toolList(args, "--only-tools").includes(tool), tool);
  }
});

test("read-only keeps no autonomy, write keeps medium with no tool list, and a repair turn is always read-only", () => {
  const readOnly = buildDroidExecArgs("/repo", "/p.txt", { sandbox: "read-only" });
  assert.equal(flag(readOnly, "--auto"), undefined);
  assert.deepEqual(toolList(readOnly, "--only-tools"), READ_ONLY_TOOLS);

  const write = buildDroidExecArgs("/repo", "/p.txt", { sandbox: "workspace-write" });
  assert.equal(flag(write, "--auto"), "medium");
  assert.equal(flag(write, "--only-tools"), undefined);

  for (const sandbox of ["run-commands", "workspace-write"]) {
    const repair = buildDroidExecArgs("/repo", "/p.txt", { sandbox, repair: true, resumeThreadId: "s", mcpTools: ["github"] });
    assert.equal(flag(repair, "--auto"), undefined, sandbox);
    assert.deepEqual(toolList(repair, "--only-tools"), READ_ONLY_TOOLS, sandbox);
    assert.equal(flag(repair, "--add-tools"), undefined, sandbox);
  }
});

test("MCP selectors join the read-only tool list, or are added to a write job's default toolset", () => {
  const mcpTools = ["github", "slack/search_messages"];
  const selectors = mcpTools.map(selector => `MCP:${selector}`);
  for (const sandbox of ["read-only", "run-commands"]) {
    const args = buildDroidExecArgs("/repo", "/p.txt", { sandbox, mcpTools });
    assert.deepEqual(toolList(args, "--only-tools"), [...READ_ONLY_TOOLS, ...selectors], sandbox);
    assert.equal(flag(args, "--add-tools"), undefined, sandbox);
  }
  const write = buildDroidExecArgs("/repo", "/p.txt", { sandbox: "workspace-write", mcpTools });
  assert.deepEqual(toolList(write, "--add-tools"), selectors);
  assert.equal(flag(write, "--only-tools"), undefined);

  const none = buildDroidExecArgs("/repo", "/p.txt", { sandbox: "read-only" });
  assert.ok(!flag(none, "--only-tools").includes("MCP:"), "no MCP tools by default");
});

test("MCP selector syntax is server or server/tool, with an optional MCP: prefix", () => {
  for (const [input, expected] of [["github", "github"], ["MCP:github", "github"], ["slack/search_messages", "slack/search_messages"], ["my%20server/do%2Fit", "my%20server/do%2Fit"]]) {
    assert.equal(normalizeMcpToolSelector(input), expected, input);
  }
  for (const bad of ["", "MCP:", "a/b/c", "/tool", "server/", "a,b", "a b", "a\tb"]) {
    assert.throws(() => normalizeMcpToolSelector(bad), /--mcp-tool/, JSON.stringify(bad));
  }
});

function repo(behavior = "review-ok") {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeDroid(binDir, behavior);
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "README.md"), "hello again\n");
  const env = buildEnv(binDir);
  const cli = (...args) => run("node", [SCRIPT, ...args], { cwd, env });
  const execArgs = () => JSON.parse(fs.readFileSync(path.join(binDir, "fake-droid-state.json"), "utf8")).threadRequests.map(request => request.args);
  return { cwd, cli, execArgs };
}

function backgroundResult(ctx, ...args) {
  const launched = ctx.cli(...args, "--background", "--json");
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const waited = ctx.cli("status", jobId, "--wait", "--json");
  assert.equal(waited.status, 0, waited.stderr);
  const result = ctx.cli("result", jobId, "--json");
  assert.equal(result.status, 0, result.stderr);
  return { jobId, payload: JSON.parse(result.stdout), text: ctx.cli("result", jobId).stdout + ctx.cli("status", jobId).stdout };
}

test("task, review and adversarial-review pass --run-commands and --mcp-tool through to droid exec", () => {
  for (const command of [["task", "run the jest suite"], ["review"], ["adversarial-review"]]) {
    const ctx = repo();
    const result = ctx.cli(...command, "--run-commands", "--mcp-tool", "github", "--mcp-tool", "MCP:slack/search");
    assert.equal(result.status, 0, result.stderr);
    const args = ctx.execArgs()[0];
    assert.equal(flag(args, "--auto"), "medium", command[0]);
    assert.deepEqual(toolList(args, "--only-tools"), [...READ_ONLY_TOOLS, "MCP:github", "MCP:slack/search"], command[0]);
  }
});

test("--run-commands and --mcp-tool carry over to a resumed task turn", () => {
  const ctx = repo();
  const launched = ctx.cli("task", "--run-commands", "--mcp-tool", "github", "--json", "first");
  assert.equal(launched.status, 0, launched.stderr);
  assert.ok(!("schemaValid" in JSON.parse(launched.stdout)), "fence flags alone keep the plain task payload, not the worker envelope");
  const resumed = ctx.cli("task", "--resume-last", "follow up");
  assert.equal(resumed.status, 0, resumed.stderr);
  const [first, second] = ctx.execArgs();
  assert.ok(second.includes("--session-id"));
  for (const args of [first, second]) {
    assert.equal(flag(args, "--auto"), "medium");
    assert.deepEqual(toolList(args, "--only-tools"), [...READ_ONLY_TOOLS, "MCP:github"]);
  }
});

test("--run-commands with --write and malformed --mcp-tool selectors are rejected before launch", () => {
  const ctx = repo();
  const both = ctx.cli("task", "--write", "--run-commands", "do it");
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /--write or --run-commands/);
  const bad = ctx.cli("task", "--mcp-tool", "a/b/c", "do it");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--mcp-tool/);
  assert.throws(() => ctx.execArgs(), /ENOENT/, "droid never ran");
});

test("a --run-commands job that changes files is flagged as a read-only violation", () => {
  const ctx = repo("writes-file");
  const { payload, text } = backgroundResult(ctx, "task", "--run-commands", "run the tests");
  assert.deepEqual(payload.readOnlyViolation, { changedFiles: ["droid-wrote.txt"] });
  assert.match(text, /Read-only violation[^\n]*droid-wrote\.txt[\s\S]*# Droid Job Status[\s\S]*Read-only violation[^\n]*droid-wrote\.txt/, "in both result and status output");

  const foreground = repo("writes-file").cli("task", "--run-commands", "run the tests");
  assert.equal(foreground.status, 0, foreground.stderr);
  assert.match(foreground.stdout, /Read-only violation[^\n]*droid-wrote\.txt/);
});

test("no violation is flagged when a --run-commands job leaves files alone, or for other job modes", () => {
  for (const [behavior, args] of [["review-ok", ["task", "--run-commands", "run the tests"]], ["writes-file", ["task", "--write", "edit things"]], ["writes-file", ["task", "look around"]]]) {
    const ctx = repo(behavior);
    const { payload, text } = backgroundResult(ctx, ...args);
    assert.equal(payload.readOnlyViolation, undefined, args.join(" "));
    assert.doesNotMatch(text, /Read-only violation/, args.join(" "));
  }
});
