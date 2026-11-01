import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { effortWarning, isLatestAlias, normalizeRequestedModel, parseDroidModels, renderModelsTable, resolveModelChoice } from "../plugins/droid/scripts/lib/models.mjs";
import { HELP_FIXTURE, buildEnv } from "./fake-droid-fixture.mjs";
import { makeTempDir, run, writeExecutable } from "./helpers.mjs";

const HELP = fs.readFileSync(HELP_FIXTURE, "utf8");
const byId = (parsed, id) => parsed.models.find(model => model.id === id);

test("Factory model IDs pass through without aliases", () => {
  assert.equal(normalizeRequestedModel(" custom:local "), "custom:local");
  assert.equal(normalizeRequestedModel("spark"), "spark");
  assert.equal(normalizeRequestedModel("  "), null);
  assert.equal(normalizeRequestedModel(undefined), null);
});

test("parseDroidModels reads ids, names, efforts and defaults from droid 0.238.0 help", () => {
  const parsed = parseDroidModels(HELP);
  assert.equal(parsed.defaultModel, "gpt-6-sol");
  assert.deepEqual(parsed.models.filter(model => model.isDefault).map(model => model.id), ["gpt-6-sol"]);
  assert.deepEqual(byId(parsed, "claude-opus-5-5"), { id: "claude-opus-5-5", name: "Opus 5.5", deprecated: false, supportsReasoning: true,
    efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", isDefault: false });
  const sol = byId(parsed, "gpt-6-sol");
  assert.equal(sol.name, "GPT-6 Sol");
  assert.ok(sol.efforts.includes("none"), "a reasoning model may list `none` as a real level");
  assert.deepEqual(byId(parsed, "mistral-medium-3.5").efforts, ["off", "high"]);
  assert.equal(byId(parsed, "deepseek-v4-pro").deprecated, true);
  assert.equal(byId(parsed, "deepseek-v4-pro").defaultEffort, "high");
  // Every listed model joins to its detail row, including "(default)"- and "[Deprecated]"-suffixed names.
  assert.deepEqual(parsed.models.filter(model => model.efforts == null).map(model => model.id), []);
});

test("parseDroidModels reports a model without reasoning support as having no efforts", () => {
  const auto = byId(parseDroidModels(HELP), "auto");
  assert.equal(auto.supportsReasoning, false);
  assert.deepEqual(auto.efforts, []);
  assert.equal(auto.defaultEffort, null);
});

test("parseDroidModels fails loudly when the models section is missing or empty", () => {
  assert.throws(() => parseDroidModels("Usage: droid exec [options]\n\nOptions:\n  -h, --help  display help\n"), /Available Models/);
  assert.throws(() => parseDroidModels("Available Models:\n\nModel details:\n  - X: supports reasoning: No; supported: [none]; default: none\n"), /listed no models/);
  assert.throws(() => parseDroidModels(undefined), /Available Models/);
});

test("parseDroidModels tolerates missing or garbled detail rows and falls back to the (default) marker", () => {
  const parsed = parseDroidModels([
    "Available Models:",
    "  alpha-1                      Alpha 1",
    "  beta-2                       Beta 2 (default)",
    "",
    "Model details:",
    "  - Alpha 1: supports reasoning maybe",
    ""
  ].join("\n"));
  assert.equal(parsed.defaultModel, "beta-2");
  assert.deepEqual(parsed.models.map(model => [model.id, model.name, model.supportsReasoning, model.efforts, model.isDefault]),
    [["alpha-1", "Alpha 1", null, null, false], ["beta-2", "Beta 2", null, null, true]]);
});

test("renderModelsTable shows each model's efforts, the CLI default and plugin defaults", () => {
  const parsed = parseDroidModels(HELP);
  const table = renderModelsTable(parsed, { model: "claude-opus-5-5", effort: null });
  assert.match(table, /CLI default model: gpt-6-sol/);
  assert.match(table, /Plugin defaults: model claude-opus-5-5, effort \(model default\)/);
  assert.match(table, /\| claude-opus-5-5 \| Opus 5\.5 \| low, medium, high, xhigh, max \| medium \|/);
  assert.match(table, /\| gpt-6-sol \(default\) \| GPT-6 Sol \|/);
  assert.match(table, /\| auto \| Auto Model \| not supported \|  \|/);
  assert.doesNotMatch(renderModelsTable(parsed), /Plugin defaults/);
});

test("model choice precedence is explicit flag, then DROID_DEFAULT_*, then none", () => {
  const env = { DROID_DEFAULT_MODEL: "env-model", DROID_DEFAULT_EFFORT: "HIGH" };
  assert.deepEqual(resolveModelChoice({ model: "flag-model", effort: "low" }, env), { model: "flag-model", effort: "low" });
  assert.deepEqual(resolveModelChoice({}, env), { model: "env-model", effort: "high" });
  assert.deepEqual(resolveModelChoice({ model: "flag-model" }, env), { model: "flag-model", effort: "high" });
  assert.deepEqual(resolveModelChoice({}, {}), { model: null, effort: null });
  assert.deepEqual(resolveModelChoice({}, { DROID_DEFAULT_MODEL: "  ", DROID_DEFAULT_EFFORT: "" }), { model: null, effort: null });
  assert.throws(() => resolveModelChoice({}, { DROID_DEFAULT_EFFORT: "turbo" }), /Unsupported reasoning effort "turbo"/);
});

const HELP_1_1 = fs.readFileSync(fileURLToPath(new URL("./fixtures/droid-exec-help-1.1.0.txt", import.meta.url)), "utf8");
const script = fileURLToPath(new URL("../plugins/droid/scripts/droid-companion.mjs", import.meta.url));
const TIERS = ["anthropic-latest-premium", "anthropic-latest-balanced", "anthropic-latest-medium", "anthropic-latest-fast", "openai-latest-premium", "openai-latest-balanced", "openai-latest-medium", "openai-latest-fast", "oss-latest-premium", "oss-latest-balanced", "oss-latest-fast"];
const WILDCARDS = ["claude-opus-*", "gpt-*-sol", "gpt-*-luna", "glm-*"];
const EXPECTED_KINDS = new Map([...TIERS.map(id => [id, "tier"]), ...WILDCARDS.map(id => [id, "wildcard"])]);

test("parseDroidModels reads tier aliases and version wildcards from the 1.1.0 help with their kinds", () => {
  const { aliases } = parseDroidModels(HELP_1_1);
  assert.deepEqual(new Set(aliases.map(alias => alias.id)), new Set(EXPECTED_KINDS.keys()));
  for (const alias of aliases) assert.equal(alias.kind, EXPECTED_KINDS.get(alias.id), alias.id);
});

test("parseDroidModels yields no aliases without the pinning section", () => {
  assert.deepEqual(parseDroidModels(HELP).aliases, []);
  const stripped = HELP_1_1.replace(/^Pinning the Latest Model:\n(?:[ \t].*\n|\n)*/m, "");
  assert.notEqual(stripped, HELP_1_1);
  assert.deepEqual(parseDroidModels(stripped).aliases, []);
});

test("isLatestAlias accepts tiers and version wildcards only", () => {
  const parsed = parseDroidModels(HELP_1_1);
  for (const id of ["anthropic-latest-fast", "glm-*", "glm-5.3", "glm-6", "gpt-6-sol", "claude-opus-5-5"]) assert.ok(isLatestAlias(id, parsed), id);
  for (const id of ["claude-opus-5-5-fast", "anthropic-latest-nope", "glm-5.3-flash", "mystery-model", "gpt-6-terra"]) assert.ok(!isLatestAlias(id, parsed), id);
});

test("effortWarning warns on an unlisted effort and stays silent for listed efforts, aliases and unknown models", () => {
  const parsed = parseDroidModels(HELP_1_1);
  const glm = parsed.models.find(model => model.id === "glm-5.3");
  assert.deepEqual(glm.efforts, ["low", "high", "max"]);
  assert.match(effortWarning("glm-5.3", "medium", parsed), /^effort "medium" is not listed for glm-5\.3 \(listed: low, high, max\); passing it anyway$/);
  assert.equal(effortWarning("glm-5.3", "HIGH", parsed), null);
  assert.equal(effortWarning("glm-*", "medium", parsed), null);
  assert.equal(effortWarning("anthropic-latest-fast", "medium", parsed), null);
  assert.equal(effortWarning("mystery-model", "medium", parsed), null);
  assert.equal(effortWarning("glm-5.3", null, parsed), null);
  assert.equal(effortWarning("auto", "high", parsed), null, "a model that lists no efforts has nothing to contradict");
});

test("renderModelsTable lists the aliases after the models", () => {
  const text = renderModelsTable(parseDroidModels(HELP_1_1));
  for (const [id, kind] of EXPECTED_KINDS) assert.ok(text.includes(`- ${id} (${kind})`), id);
  assert.ok(text.indexOf("Latest-model aliases:") > text.lastIndexOf("| glm-5.3 "));
});

function cliFixture() {
  const bin = makeTempDir();
  writeExecutable(path.join(bin, "droid.cjs"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("droid-cli test 1.1.0");
else if (args[0] === "exec" && args.includes("--help")) process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/droid-exec-help-1.1.0.txt"))}, "utf8"));
else process.exit(2);
`);
  const dataDir = makeTempDir();
  const env = { ...buildEnv(bin), CLAUDE_PLUGIN_DATA: dataDir, DROID_HOME: makeTempDir() };
  const exec = (...args) => {
    const result = run(process.execPath, [script, ...args], { cwd: makeTempDir(), env });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result;
  };
  return { exec, defaults: () => JSON.parse(fs.readFileSync(path.join(dataDir, "defaults.json"), "utf8")) };
}

test("setup stores an unlisted effort with a warning and does not warn for a wildcard model", () => {
  const { exec, defaults } = cliFixture();
  const unlisted = exec("setup", "--default-model", "glm-5.3", "--default-effort", "medium");
  assert.match(unlisted.stderr, /not listed for glm-5\.3/);
  assert.deepEqual(defaults(), { model: "glm-5.3", effort: "medium" });
  const wildcard = exec("setup", "--default-model", "glm-*");
  assert.doesNotMatch(wildcard.stderr, /not listed/);
  assert.equal(defaults().model, "glm-*");
  assert.doesNotMatch(exec("setup", "--default-model", "anthropic-latest-fast").stderr, /not listed/);
  assert.match(exec("setup", "--default-model", "mystery-model").stderr, /model "mystery-model" is not listed/);
});

test("models --json carries every alias and the text table lists them; stored unlisted effort warns", () => {
  const { exec } = cliFixture();
  exec("setup", "--default-model", "glm-5.3", "--default-effort", "medium");
  const json = exec("models", "--json");
  assert.deepEqual(new Set(JSON.parse(json.stdout).aliases.map(alias => alias.id)), new Set(EXPECTED_KINDS.keys()));
  assert.match(json.stderr, /not listed for glm-5\.3/);
  const table = exec("models").stdout;
  for (const id of EXPECTED_KINDS.keys()) assert.ok(table.includes(id), id);
});
