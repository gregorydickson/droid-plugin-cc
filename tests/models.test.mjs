import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRequestedModel } from "../plugins/droid/scripts/lib/models.mjs";
test("Factory model IDs pass through without aliases", () => {
  assert.equal(normalizeRequestedModel(" custom:local "), "custom:local");
  assert.equal(normalizeRequestedModel("spark"), "spark");
  assert.equal(normalizeRequestedModel("  "), null);
  assert.equal(normalizeRequestedModel(undefined), null);
});
