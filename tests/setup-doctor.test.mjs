import fs from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeDroid, DOCTOR_FIXTURE } from "./fake-droid-fixture.mjs";

const script = fileURLToPath(new URL("../plugins/droid/scripts/droid-companion.mjs", import.meta.url));
const fixtureResults = JSON.parse(fs.readFileSync(DOCTOR_FIXTURE, "utf8")).results;
const FIXTURE_WARN_IDS = fixtureResults.filter(result => result.status === "warn" || result.status === "fail").map(result => result.id);
const DEGRADED = { loggedIn: null, verified: false, warningIds: ["doctor"] };

const MODES = {
  ok: { loggedIn: true, verified: true, warningIds: [] },
  warn: { loggedIn: true, verified: true, warningIds: FIXTURE_WARN_IDS },
  "auth-fail": { loggedIn: false, verified: true, warningIds: [...FIXTURE_WARN_IDS, "auth.verify"] },
  "no-auth": { loggedIn: null, verified: false, warningIds: FIXTURE_WARN_IDS },
  "fail-exit": DEGRADED,
  invalid: DEGRADED,
  hang: DEGRADED
};

function setupJson(mode, extraEnv = {}) {
  const root = makeTempDir(); initGitRepo(root);
  const bin = makeTempDir(); installFakeDroid(bin);
  const env = { ...buildEnv(bin), DROID_HOME: makeTempDir(), FAKE_DROID_DOCTOR: mode, DROID_DOCTOR_TIMEOUT_MS: "500", ...extraEnv };
  const start = performance.now();
  const result = run(process.execPath, [script, "setup", "--json"], { cwd: root, env });
  const elapsedMs = performance.now() - start;
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return { report: JSON.parse(result.stdout), elapsedMs, text: run(process.execPath, [script, "setup"], { cwd: root, env }).stdout };
}

const pick = auth => ({ loggedIn: auth.loggedIn, verified: auth.verified, warningIds: auth.warnings.map(warning => warning.id) });

for (const [mode, row] of Object.entries(MODES)) {
  test(`setup reports ${mode} doctor as ${JSON.stringify(row)}`, () => {
    const { report, text } = setupJson(mode);
    assert.deepEqual(pick(report.auth), row);
    assert.equal(report.auth.source, mode.startsWith("fail") || ["invalid", "hang"].includes(mode) ? "exec" : "doctor");
    for (const id of row.warningIds) assert.ok(text.includes(`[${id}]`), `text output names warning ${id}`);
    assert.equal(report.ready, true, "doctor failure never fails setup");
  });
}

test("warn mode keeps each warning's detail and remediation", () => {
  const { report } = setupJson("warn");
  const expected = fixtureResults.filter(result => FIXTURE_WARN_IDS.includes(result.id)).map(({ id, status, detail, remediation }) => ({ id, status, detail, remediation }));
  assert.deepEqual(report.auth.warnings, expected);
  assert.equal(report.auth.label, "host Droid health");
});

test("a hung doctor degrades within the timeout plus slack", () => {
  const { report, elapsedMs } = setupJson("hang");
  assert.ok(elapsedMs < 5000, `setup took ${elapsedMs} ms`);
  assert.match(report.auth.warnings.find(warning => warning.id === "doctor").detail, /timed out/);
});

test("AC7.3 live: this machine's Droid is logged in and verified", { skip: process.env.DROID_SMOKE !== "1", timeout: 60000 }, () => {
  const root = makeTempDir(); initGitRepo(root);
  const result = run(process.execPath, [script, "setup", "--json"], { cwd: root, env: { ...process.env, CLAUDE_PLUGIN_DATA: makeTempDir("droid-smoke-data-") }, timeout: 45000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const { auth } = JSON.parse(result.stdout);
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.verified, true);
});
