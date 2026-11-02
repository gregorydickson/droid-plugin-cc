import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { installFakeDroid, buildEnv } from "./fake-droid-fixture.mjs";
import { buildDroidExecArgs, JOB_KINDS } from "../plugins/droid/scripts/lib/droid.mjs";
import { STOP_REPORT_INSTRUCTIONS } from "../plugins/droid/scripts/lib/worker-context.mjs";

const script = fileURLToPath(new URL("../plugins/droid/scripts/droid-companion.mjs", import.meta.url));
const flagValue = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;

const INSTRUCTIONS = { name: "rules.md", body: "RULES-SENTINEL never push" };
const BRIEF = { name: "brief.md", body: "BRIEF-SENTINEL count rows" };
const PREREAD = { name: "plan.md", body: "PREREAD-SENTINEL plan text" };
const SCHEMA = JSON.stringify({ type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false });

const instructionBlock = (named = INSTRUCTIONS.name) => `Project instructions (${named}):\n${INSTRUCTIONS.body}`;
const inputBlock = `Preread context (source data):\n${JSON.stringify([{ path: PREREAD.name, content: PREREAD.body }])}`;
// What each turn kind is specified to send as its system prompt (null: no system prompt file at all).
// A resume or fork re-reads the stored job's instruction files by absolute path; an answer reuses the paused job as written.
const TASK_SET = () => instructionBlock();
const PAUSE_SET = () => `${instructionBlock()}\n\n${STOP_REPORT_INSTRUCTIONS}`;
const REVIEW_SET = () => [instructionBlock(), BRIEF.body, inputBlock].join("\n\n");
const STORED_TASK_SET = root => instructionBlock(path.join(root, INSTRUCTIONS.name));
const CONTEXT_FLAGS = ["--brief", BRIEF.name, "--instructions", INSTRUCTIONS.name, "--preread", PREREAD.name];
const INSTRUCTION_FLAGS = ["--instructions", INSTRUCTIONS.name];

function fixture(t, { worker }) {
  const root = fs.realpathSync(makeTempDir()); initGitRepo(root);
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  for (const file of [INSTRUCTIONS, BRIEF, PREREAD]) fs.writeFileSync(path.join(root, file.name), file.body);
  fs.writeFileSync(path.join(root, "schema.json"), SCHEMA);
  run("git", ["add", "."], { cwd: root }); run("git", ["commit", "-m", "init"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "hello changed\n");
  const bin = makeTempDir(); installFakeDroid(bin, "review-ok", worker);
  const env = { ...buildEnv(bin), DROID_HOME: makeTempDir(), CLAUDE_PLUGIN_DATA: makeTempDir(), DROID_COMPANION_SESSION_ID: "turn-kinds" };
  const cli = (...args) => {
    const result = run(process.execPath, [script, ...args, "--json"], { cwd: root, env });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  const turns = () => JSON.parse(fs.readFileSync(path.join(bin, "fake-droid-state.json"), "utf8"));
  return { root, cli, last: () => ({ ...turns().lastTurnStart, args: turns().threadRequests.at(-1).args }) };
}

// `run` drives the turn under test and returns the job id the turn is tagged with.
const ROWS = [
  { name: "task", kind: "task", worker: true, systemPrompt: TASK_SET, leaked: [INSTRUCTIONS.body],
    run: f => f.cli("task", ...CONTEXT_FLAGS, "--output-schema", "schema.json", "Do the thing").jobId },
  { name: "task --pause-and-ask", kind: "task", worker: true, systemPrompt: PAUSE_SET, leaked: [INSTRUCTIONS.body, STOP_REPORT_INSTRUCTIONS],
    run: f => f.cli("task", "--pause-and-ask", ...INSTRUCTION_FLAGS, "--output-schema", "schema.json", "Do the thing").jobId },
  { name: "review", kind: "review", worker: false, systemPrompt: REVIEW_SET, leaked: [INSTRUCTIONS.body, BRIEF.body, PREREAD.body],
    run: f => f.cli("review", ...CONTEXT_FLAGS).jobId },
  { name: "adversarial-review", kind: "adversarial-review", worker: false, systemPrompt: REVIEW_SET, leaked: [INSTRUCTIONS.body, BRIEF.body, PREREAD.body],
    run: f => f.cli("adversarial-review", ...CONTEXT_FLAGS).jobId },
  { name: "resume", kind: "task", worker: true, systemPrompt: STORED_TASK_SET, leaked: [INSTRUCTIONS.body],
    run: f => {
      f.cli("task", ...INSTRUCTION_FLAGS, "--output-schema", "schema.json", "Start");
      return f.cli("task", "--resume-last", "Continue").jobId;
    } },
  { name: "answer", kind: "task", worker: true, systemPrompt: PAUSE_SET, leaked: [INSTRUCTIONS.body, STOP_REPORT_INSTRUCTIONS],
    run: f => {
      const paused = f.cli("task", "--pause-and-ask", ...INSTRUCTION_FLAGS, "--output-schema", "schema.json", "NEED_ANSWER");
      assert.equal(paused.status, "awaiting-answer");
      return f.cli("answer", paused.jobId, "yes").jobId;
    } },
  { name: "fork", kind: "task", worker: true, systemPrompt: STORED_TASK_SET, leaked: [INSTRUCTIONS.body],
    run: f => {
      const parent = f.cli("task", ...INSTRUCTION_FLAGS, "--output-schema", "schema.json", "Start");
      const forked = f.cli("task", "--fork", parent.jobId, "Branch");
      assert.notEqual(forked.jobId, parent.jobId);
      return forked.jobId;
    } },
  { name: "mission", kind: "mission", worker: true, systemPrompt: () => null, leaked: [],
    run: f => {
      const { jobId } = f.cli("mission", "--background", "Create hello.txt");
      f.cli("status", jobId, "--wait");
      return jobId;
    } }
];

test("every job kind has a turn-kind row", () => {
  assert.deepEqual(new Set(JOB_KINDS).difference(new Set(ROWS.map(row => row.kind))), new Set());
});

for (const row of ROWS) {
  test(`${row.name} turn carries its specified system prompt and session tag`, t => {
    const f = fixture(t, { worker: row.worker });
    const jobId = row.run(f);
    const { args, systemPrompt, prompt } = f.last();
    const expected = row.systemPrompt(f.root);
    assert.equal(args.includes("--append-system-prompt-file"), expected !== null, args.join(" "));
    assert.equal(systemPrompt, expected);
    for (const text of row.leaked) assert.ok(!prompt.includes(text), `prompt repeats ${JSON.stringify(text)}`);
    assert.deepEqual(JSON.parse(flagValue(args, "--tag")), { name: "droid-plugin-cc", metadata: { jobId, kind: row.kind } });
  });
}

test("an adversarial review sends its brief and preread once, in the system prompt", t => {
  const f = fixture(t, { worker: false });
  f.cli("adversarial-review", ...CONTEXT_FLAGS);
  const { prompt, systemPrompt } = f.last();
  for (const text of [BRIEF.body, PREREAD.body]) {
    assert.ok(systemPrompt.includes(text), text);
    assert.ok(!prompt.includes(text), text);
  }
});

const PER_KIND_FLAGS = ["--mission", "--fork", "--use-spec", "--append-system-prompt-file", "--input-format"];
const REPAIR_BASE = { tag: { jobId: "task-abc", kind: "task" }, model: "glm-5.3", sandbox: "read-only" };
const PER_KIND_OPTIONS = {
  mission: true, forkThreadId: "parent-thread", spec: true, systemPromptFile: "/tmp/system-prompt.txt", steerable: true
};

for (const [key, value] of Object.entries(PER_KIND_OPTIONS)) {
  test(`a repair turn built with ${key} carries no per-kind flag${key === "steerable" ? "" : " and keeps its tag"}`, () => {
    const args = buildDroidExecArgs("/repo", "/p.txt", { ...REPAIR_BASE, [key]: value, repair: true });
    for (const flag of PER_KIND_FLAGS) assert.ok(!args.includes(flag), `${flag} in ${args.join(" ")}`);
    // A steerable turn is untagged by design (see droid-transport tests), so only the other keys can show the tag survives.
    if (key !== "steerable") assert.equal(JSON.parse(flagValue(args, "--tag")).metadata.jobId, REPAIR_BASE.tag.jobId);
  });
}

test("a repair turn built with every per-kind option except steerable carries no per-kind flag and keeps its tag", () => {
  const { steerable, ...rest } = PER_KIND_OPTIONS;
  const args = buildDroidExecArgs("/repo", "/p.txt", { ...REPAIR_BASE, ...rest, repair: true });
  for (const flag of PER_KIND_FLAGS) assert.ok(!args.includes(flag), flag);
  assert.deepEqual(JSON.parse(flagValue(args, "--tag")), { name: "droid-plugin-cc", metadata: REPAIR_BASE.tag });
});
