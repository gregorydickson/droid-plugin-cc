import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeDroid } from "./fake-droid-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import {
  DROID_FEATURE_FLOOR,
  droidCapabilities,
  requireDroidCapability
} from "../plugins/droid/scripts/lib/droid.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "droid", "scripts", "droid-companion.mjs");

const KEYS = Object.keys(droidCapabilities(DROID_FEATURE_FLOOR));
const expectAll = value => Object.fromEntries(KEYS.map(key => [key, value]));

test("every capability flips together at the floor", () => {
  assert.ok(KEYS.length > 0, "capability keys must exist");
  for (const [version, expected] of [
    ["1.1.0", true],
    ["1.2.3", true],
    ["0.238.0", false],
    ["droid-cli test garbage", true],
    [null, true]
  ]) {
    assert.deepEqual({ ...droidCapabilities(version) }, expectAll(expected), String(version));
  }
});

test("capabilities are frozen", () => {
  assert.ok(Object.isFrozen(droidCapabilities("1.1.0")));
});

test("requireDroidCapability throws the exact floor message below the floor and returns at it", () => {
  for (const key of KEYS) {
    assert.throws(() => requireDroidCapability(key, "0.238.0"), { message: "requires Droid CLI >= 1.1.0 (found 0.238.0)" });
    assert.doesNotThrow(() => requireDroidCapability(key, "1.1.0"));
    assert.doesNotThrow(() => requireDroidCapability(key, null));
  }
  assert.throws(() => requireDroidCapability("nonsense", "1.1.0"), /Unknown Droid capability/);
});

function setupReport(version) {
  const binDir = makeTempDir();
  installFakeDroid(binDir);
  const env = buildEnv(binDir);
  if (version !== undefined) env.FAKE_DROID_VERSION = version;
  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: ROOT, env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const namesFloor = report => report.nextSteps.some(step => step.includes(DROID_FEATURE_FLOOR));

test("setup reports a version below the floor with a next step naming the floor", () => {
  const report = setupReport("0.238.0");
  assert.equal(report.droid.version, "0.238.0");
  assert.ok(namesFloor(report));
  assert.ok(report.nextSteps.some(step => step.includes("0.238.0")));
});

test("setup reports the default fake at the floor with no version step", () => {
  const report = setupReport();
  assert.equal(report.droid.version, DROID_FEATURE_FLOOR);
  assert.equal(namesFloor(report), false);
});

test("setup reports an unparseable version as null with a warning", () => {
  const report = setupReport("garbage");
  assert.equal(report.droid.version, null);
  assert.ok(namesFloor(report));
});
