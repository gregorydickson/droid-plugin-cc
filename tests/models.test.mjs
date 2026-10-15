import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRequestedModel, parseDroidModels, renderModelsTable, resolveModelChoice } from "../plugins/droid/scripts/lib/models.mjs";
import { HELP_FIXTURE } from "./fake-droid-fixture.mjs";

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
