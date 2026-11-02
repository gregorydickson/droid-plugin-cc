import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeDroid } from "./fake-droid-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { buildDroidExecArgs, normalizeMcpToolSelector, readOnlyToolbox, READ_ONLY_TOOLS, RUN_COMMANDS_TOOLS, REPAIR_TOOLS, WEB_TOOLS, SUBAGENT_TOOLS } from "../plugins/droid/scripts/lib/droid.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "droid", "scripts", "droid-companion.mjs");
const FILE_EDITING_TOOLS = ["Edit", "Create", "ApplyPatch", "MultiEdit", "Write"];

const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const toolList = (args, name) => flag(args, name)?.split(",");
const toolSet = (args, name) => new Set(toolList(args, name));
// droid-lock.sh refuses a run-commands --only-tools member outside these five (plus MCP selectors).
const LANE_SAFE_TOOLS = new Set(["Read", "LS", "Grep", "Glob", "Execute"]);

test("the sandbox tool lists are frozen and split by what a lane may run", () => {
  for (const list of [READ_ONLY_TOOLS, WEB_TOOLS, SUBAGENT_TOOLS, RUN_COMMANDS_TOOLS, REPAIR_TOOLS]) assert.ok(Object.isFrozen(list));
  assert.deepEqual(new Set(RUN_COMMANDS_TOOLS), LANE_SAFE_TOOLS);
  assert.deepEqual(new Set(REPAIR_TOOLS), LANE_SAFE_TOOLS);
  assert.deepEqual(new Set(WEB_TOOLS), new Set(["WebSearch", "FetchUrl"]));
  assert.deepEqual(new Set(SUBAGENT_TOOLS), new Set(["Task", "TaskOutput", "TaskStop"]));
  assert.deepEqual(new Set(READ_ONLY_TOOLS), new Set([...LANE_SAFE_TOOLS, "WebSearch", "FetchUrl", "Skill", "ToolSearch", "TodoWrite", "Task", "TaskOutput", "TaskStop"]));
  for (const tool of [...WEB_TOOLS, ...SUBAGENT_TOOLS]) assert.ok(!RUN_COMMANDS_TOOLS.includes(tool), tool);
  for (const tool of FILE_EDITING_TOOLS) assert.ok(!READ_ONLY_TOOLS.includes(tool), tool);
});

const MCP = ["github", "slack/search_messages"];
const MCP_SELECTORS = MCP.map(selector => `MCP:${selector}`);

for (const [consumer, options] of [
  ["review / adversarial-review", { sandbox: "read-only" }],
  ["read-only task", { sandbox: "read-only" }],
  ["resumed read-only task", { sandbox: "read-only", resumeThreadId: "session-1" }],
]) {
  test(`${consumer} gets READ_ONLY_TOOLS plus its MCP selectors and no autonomy flag`, () => {
    for (const mcpTools of [undefined, MCP]) {
      const args = buildDroidExecArgs("/repo", "/p.txt", { ...options, mcpTools });
      assert.deepEqual(toolSet(args, "--only-tools"), new Set([...READ_ONLY_TOOLS, ...(mcpTools ? MCP_SELECTORS : [])]));
      assert.ok(!args.includes("--auto"));
      assert.equal(flag(args, "--add-tools"), undefined);
      assert.equal(flag(args, "--output-format"), options.resumeThreadId ? "stream-json" : "stream-jsonrpc");
      assert.ok(!args.includes("--input-format"), "flags configure only a one-shot exec; an --input-format JSON-RPC session would ignore them");
    }
  });
}

test("run-commands gets only the lane-safe tools plus MCP selectors under medium autonomy, fresh and resumed", () => {
  for (const resumeThreadId of [undefined, "session-1"]) {
    for (const mcpTools of [undefined, MCP]) {
      const args = buildDroidExecArgs("/repo", "/p.txt", { sandbox: "run-commands", resumeThreadId, mcpTools });
      assert.equal(flag(args, "--auto"), "medium", String(resumeThreadId));
      assert.deepEqual(toolSet(args, "--only-tools"), new Set([...RUN_COMMANDS_TOOLS, ...(mcpTools ? MCP_SELECTORS : [])]));
      for (const tool of toolList(args, "--only-tools")) assert.ok(LANE_SAFE_TOOLS.has(tool) || tool.startsWith("MCP:"), tool);
      assert.equal(flag(args, "--output-format"), resumeThreadId ? "stream-json" : "stream-jsonrpc");
      assert.ok(!args.includes("--input-format"));
    }
  }
});

test("a repair turn gets REPAIR_TOOLS, no MCP selectors and no autonomy flag whatever the job's sandbox", () => {
  for (const sandbox of ["read-only", "run-commands", "workspace-write"]) {
    const repair = buildDroidExecArgs("/repo", "/p.txt", { sandbox, repair: true, resumeThreadId: "s", mcpTools: ["github"] });
    assert.ok(!repair.includes("--auto"), sandbox);
    assert.deepEqual(toolSet(repair, "--only-tools"), new Set(REPAIR_TOOLS), sandbox);
    assert.equal(flag(repair, "--add-tools"), undefined, sandbox);
  }
});

test("workspace-write keeps medium autonomy with no tool list, and MCP selectors are added to its default toolset", () => {
  const write = buildDroidExecArgs("/repo", "/p.txt", { sandbox: "workspace-write" });
  assert.equal(flag(write, "--auto"), "medium");
  assert.equal(flag(write, "--only-tools"), undefined);

  const withMcp = buildDroidExecArgs("/repo", "/p.txt", { sandbox: "workspace-write", mcpTools: MCP });
  assert.deepEqual(toolList(withMcp, "--add-tools"), MCP_SELECTORS);
  assert.equal(flag(withMcp, "--only-tools"), undefined);

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
  return { cwd, binDir, env, cli, execArgs };
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
    assert.deepEqual(toolSet(args, "--only-tools"), new Set([...RUN_COMMANDS_TOOLS, "MCP:github", "MCP:slack/search"]), command[0]);
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
    assert.deepEqual(toolSet(args, "--only-tools"), new Set([...RUN_COMMANDS_TOOLS, "MCP:github"]));
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

test("a resumed --run-commands turn that leaves files alone does not inherit the violation of the turn before it", () => {
  const ctx = repo("writes-file");
  const first = backgroundResult(ctx, "task", "--run-commands", "run the tests");
  assert.deepEqual(first.payload.readOnlyViolation, { changedFiles: ["droid-wrote.txt"] });
  installFakeDroid(ctx.binDir, "review-ok");
  const resumed = backgroundResult(ctx, "task", "--resume-last", "run them again");
  const args = ctx.execArgs().at(-1);
  assert.ok(args.includes("--session-id") && flag(args, "--auto") === "medium", `the resumed turn replays --run-commands: ${args.join(" ")}`);
  assert.notEqual(resumed.jobId, first.jobId);
  assert.deepEqual(resumed.payload.changedFiles ?? [], []);
  assert.equal(resumed.payload.readOnlyViolation, undefined);
  assert.doesNotMatch(resumed.text, /Read-only violation/);
});

test("no violation is flagged when a --run-commands job leaves files alone, or for other job modes", () => {
  for (const [behavior, args] of [["review-ok", ["task", "--run-commands", "run the tests"]], ["writes-file", ["task", "--write", "edit things"]], ["writes-file", ["task", "look around"]]]) {
    const ctx = repo(behavior);
    const { payload, text } = backgroundResult(ctx, ...args);
    assert.equal(payload.readOnlyViolation, undefined, args.join(" "));
    assert.doesNotMatch(text, /Read-only violation/, args.join(" "));
  }
});

const OPT_OUTS = [
  { flags: ["--no-web"], dropped: WEB_TOOLS },
  { flags: ["--no-subagents"], dropped: SUBAGENT_TOOLS },
  { flags: ["--no-web", "--no-subagents"], dropped: [...WEB_TOOLS, ...SUBAGENT_TOOLS] },
];
const expectedReadOnly = dropped => new Set([...READ_ONLY_TOOLS.filter(tool => !dropped.includes(tool)), "MCP:github"]);

test("buildDroidExecArgs drops exactly the opted-out tool groups and keeps MCP selectors", () => {
  for (const { dropped } of OPT_OUTS) {
    const flagsFor = { noWeb: WEB_TOOLS.every(tool => dropped.includes(tool)), noSubagents: SUBAGENT_TOOLS.every(tool => dropped.includes(tool)) };
    for (const resumeThreadId of [undefined, "session-1"]) {
      const args = buildDroidExecArgs("/repo", "/p.txt", { sandbox: "read-only", resumeThreadId, mcpTools: ["github"], ...flagsFor });
      assert.deepEqual(toolSet(args, "--only-tools"), expectedReadOnly(dropped));
    }
  }
  for (const tool of RUN_COMMANDS_TOOLS) assert.ok(toolSet(buildDroidExecArgs("/repo", "/p.txt", { sandbox: "read-only", noWeb: true, noSubagents: true }), "--only-tools").has(tool), tool);
});

// droid rejects an --only-tools list naming a tool it lacks, so a CLI below 1.1.0 must not see the wide list.
const TOOLBOX_BY_VERSION = [["0.238.0", RUN_COMMANDS_TOOLS], ["1.1.0", READ_ONLY_TOOLS], ["droid-cli garbage", READ_ONLY_TOOLS]];
const fakeEnv = version => {
  const binDir = makeTempDir();
  installFakeDroid(binDir);
  return { binDir, env: { ...buildEnv(binDir), FAKE_DROID_VERSION: version } };
};

test("readOnlyToolbox is the wide list from 1.1.0 (or an unparseable version) and the narrow five below it", () => {
  for (const [version, expected] of TOOLBOX_BY_VERSION) assert.equal(readOnlyToolbox(version), expected, version);
});

test("a read-only turn's --only-tools follows the installed CLI's version, fresh and resumed", () => {
  for (const [version, expected] of TOOLBOX_BY_VERSION) {
    const { env } = fakeEnv(version);
    for (const resumeThreadId of [undefined, "session-1"]) {
      const args = buildDroidExecArgs("/repo", "/p.txt", { sandbox: "read-only", resumeThreadId, mcpTools: ["github"], env });
      assert.deepEqual(toolSet(args, "--only-tools"), new Set([...expected, "MCP:github"]), `${version} ${resumeThreadId ?? "fresh"}`);
    }
  }
});

test("a read-only task on a CLI below 1.1.0 runs with the narrow five and no wide-only tool", () => {
  const ctx = repo();
  const { binDir, env } = fakeEnv("0.238.0");
  const result = run("node", [SCRIPT, "task", "look around"], { cwd: ctx.cwd, env });
  assert.equal(result.status, 0, result.stderr);
  const recorded = JSON.parse(fs.readFileSync(path.join(binDir, "fake-droid-state.json"), "utf8")).threadRequests[0].args;
  assert.deepEqual(toolSet(recorded, "--only-tools"), new Set(RUN_COMMANDS_TOOLS));
});

for (const { flags, dropped } of OPT_OUTS) {
  for (const command of [["task"], ["review"], ["adversarial-review"]]) {
    test(`${command[0]} ${flags.join(" ")} drops exactly ${dropped.join("/")} from --only-tools`, () => {
      const ctx = repo();
      const result = ctx.cli(...command, ...flags, "--mcp-tool", "github", ...(command[0] === "task" ? ["look around"] : []));
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(toolSet(ctx.execArgs()[0], "--only-tools"), expectedReadOnly(dropped));
    });
  }

  test(`${flags.join(" ")} carries over to a resumed task turn and keeps the plain task payload`, () => {
    const ctx = repo();
    const plain = ctx.cli("task", "--json", "first");
    assert.equal(plain.status, 0, plain.stderr);
    const launched = ctx.cli("task", ...flags, "--mcp-tool", "github", "--json", "first");
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(Object.keys(JSON.parse(launched.stdout)).sort(), Object.keys(JSON.parse(plain.stdout)).sort());
    const resumed = ctx.cli("task", "--resume-last", "follow up");
    assert.equal(resumed.status, 0, resumed.stderr);
    const [, first, second] = ctx.execArgs();
    assert.ok(second.includes("--session-id"));
    for (const args of [first, second]) assert.deepEqual(toolSet(args, "--only-tools"), expectedReadOnly(dropped));
  });
}

test("a read-only job under a droid-lock.sh binary is not filtered, and --write rejects the opt-outs", () => {
  const ctx = repo();
  const binDir = makeTempDir();
  installFakeDroid(binDir);
  const lock = path.join(binDir, "droid-lock.sh");
  fs.copyFileSync(path.join(binDir, "droid.cjs"), lock);
  fs.chmodSync(lock, 0o755);
  const env = { ...buildEnv(binDir), DROID_BINARY: lock };
  const result = run("node", [SCRIPT, "task", "look around"], { cwd: ctx.cwd, env });
  assert.equal(result.status, 0, result.stderr);
  const recorded = JSON.parse(fs.readFileSync(path.join(binDir, "fake-droid-state.json"), "utf8")).threadRequests[0].args;
  assert.deepEqual(new Set(toolList(recorded, "--only-tools")), new Set(READ_ONLY_TOOLS));

  for (const flagName of ["--no-web", "--no-subagents"]) {
    const rejected = ctx.cli("task", "--write", flagName, "do it");
    assert.equal(rejected.status, 1, flagName);
    assert.match(rejected.stderr, /--no-web and --no-subagents apply to read-only jobs; --write uses Droid's default toolset\./);
  }
  assert.throws(() => ctx.execArgs(), /ENOENT/, "droid never ran");
});

test("the stop-review hook runs its task without the web tools", () => {
  const ctx = repo();
  assert.equal(ctx.cli("setup", "--enable-review-gate", "--json").status, 0);
  const hook = run("node", [path.join(path.dirname(SCRIPT), "stop-review-gate-hook.mjs")], {
    cwd: ctx.cwd,
    env: ctx.env,
    input: JSON.stringify({ cwd: ctx.cwd, session_id: "sess-fence", last_assistant_message: "done" })
  });
  assert.equal(hook.status, 0, hook.stderr);
  const tools = toolSet(ctx.execArgs()[0], "--only-tools");
  for (const tool of WEB_TOOLS) assert.ok(!tools.has(tool), tool);
  for (const tool of SUBAGENT_TOOLS) assert.ok(tools.has(tool), tool);
});
