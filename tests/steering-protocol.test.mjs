import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { makeTempDir, smokeEnv } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC = fs.readFileSync(path.join(ROOT, "docs/live-steering.md"), "utf8");
const TRANSCRIPT = fs.readFileSync(path.join(ROOT, "tests/fixtures/droid-input-session-1.1.0.ndjson"), "utf8")
  .trim().split("\n").map(line => JSON.parse(line));

// Each fence row of the doc's table, and the session-settings field that carries it.
const FENCE_KEYS = { model: "modelId", effort: "reasoningEffort", autonomy: "autonomyLevel", "tool list": "restrictToolIds" };
const SETTINGS_ROW = "--settings";
const SETTING_METHODS = new Set(["droid.initialize_session", "droid.update_session_settings", "droid.list_tools"]);
const ENVELOPE = { jsonrpc: "2.0", factoryApiVersion: "1.0.0", factoryProtocolVersion: "1.257.0", type: "request" };
const PROBE_FILE = "probe.txt";
const LIVE_TIMEOUT_MS = 300000;
const live = { skip: process.env.DROID_SMOKE !== "1", timeout: LIVE_TIMEOUT_MS };

const note = message => message.params?.notification;
const isResponse = (message, id) => message.id === id && ("result" in message || "error" in message);
const confirmationOf = (outputs, id) => outputs.find(m => note(m)?.type === "settings_updated" && note(m).requestId === id);
const turnEnded = message => note(message)?.type === "agent_turn_completed";

function settableRows(doc) {
  const section = doc.split("## What can be set")[1].split("\n## ")[0];
  const rows = section.split("\n").filter(line => line.startsWith("| ") && !line.startsWith("| Setting") && !line.startsWith("|---"))
    .map(line => line.split("|").slice(1, 3).map(cell => cell.trim().replaceAll("`", "")));
  return new Map(rows);
}

const ROWS = settableRows(DOC);
const yes = row => ROWS.get(row) === "yes";
const transcriptRequests = TRANSCRIPT.filter(row => row.dir === "in").map(row => row.msg);
const transcriptOutputs = TRANSCRIPT.filter(row => row.dir === "out").map(row => row.msg);

/**
 * Checks that every setting request was applied: the initialize result and each update's
 * settings_updated confirmation carry the requested value for every fence field the request
 * names, and list_tools allows exactly the tool list in force. Returns the confirmed fields and
 * the tool list and autonomy in force after the last request.
 */
function verifySettingRequests(requests, outputs) {
  const confirmed = new Set();
  let toolList = null, autonomy = null;
  for (const { id, method, params } of requests) {
    const response = outputs.find(m => isResponse(m, id));
    assert.ok(response && !response.error, `${method} was answered without an error: ${JSON.stringify(response?.error)}`);
    if (method === "droid.list_tools") {
      const allowed = response.result.tools.filter(tool => tool.currentlyAllowed).map(tool => tool.llmId);
      assert.deepEqual(new Set(allowed), new Set(toolList), "list_tools allows exactly the tool list in force");
      confirmed.add(method);
      continue;
    }
    const settings = method === "droid.initialize_session" ? response.result.settings : note(confirmationOf(outputs, id) ?? {})?.settings;
    assert.ok(settings, `${method} ${JSON.stringify(params)} was confirmed by a settings_updated carrying its requestId`);
    for (const key of Object.values(FENCE_KEYS)) {
      if (!(key in params)) continue;
      assert.deepEqual(settings[key], params[key], `${method} set ${key}`);
      confirmed.add(key);
    }
    toolList = settings.restrictToolIds ?? toolList;
    autonomy = settings.autonomyLevel ?? autonomy;
  }
  return { confirmed, toolList, autonomy };
}

// Autonomy "off" removes the edit tools whatever the tool list says, so a Create refused there
// proves nothing about the list: the probe must run where autonomy alone would allow Create.
function assertProbeIsolatesToolList({ toolList, autonomy }) {
  assert.ok(!toolList.includes("Create"), `the tool list in force is read-only: ${toolList}`);
  assert.notEqual(autonomy, "off", "autonomy in force would allow Create, so only the tool list can refuse it");
}

function assertYesRowsConfirmed({ confirmed }) {
  for (const [row, key] of Object.entries(FENCE_KEYS)) if (yes(row)) assert.ok(confirmed.has(key), `the '${row}' row is yes, so a captured request sets and confirms ${key}`);
  if (yes("tool list")) assert.ok(confirmed.has("droid.list_tools"), "the tool list is checked through list_tools");
}

test("the doc's table has one settable row per fence setting and --settings", () => {
  assert.deepEqual(new Set(ROWS.keys()), new Set([...Object.keys(FENCE_KEYS), SETTINGS_ROW]));
  for (const [row, settable] of ROWS) assert.ok(["yes", "no"].includes(settable), `${row} is yes or no, got ${settable}`);
});

test("the decision line follows mechanically from the table", () => {
  const decision = DOC.trimEnd().split("\n").at(-1);
  const missingCore = ["model", "effort"].filter(row => !yes(row));
  const missingFence = ["autonomy", "tool list"].filter(row => !yes(row));
  if (missingCore.length > 0) assert.match(decision, /^Decision: NO-GO — .+$/);
  else if (missingFence.length > 0) assert.equal(decision, `Decision: GO-WARN — not settable: ${missingFence.join(", ")}`);
  else assert.equal(decision, "Decision: GO");
});

test("the captured transcript confirms every setting request it makes", () => {
  const requests = transcriptRequests.filter(request => SETTING_METHODS.has(request.method));
  assertYesRowsConfirmed(verifySettingRequests(requests, transcriptOutputs));
});

test("the captured transcript shows a read-only tool list refusing the Create probe", { skip: !yes("tool list") }, () => {
  const probe = transcriptRequests.find(request => request.method === "droid.add_user_message" && request.params.text.includes(PROBE_FILE));
  assert.ok(probe, "the transcript holds the Create probe");
  const from = TRANSCRIPT.findIndex(row => row.msg === probe);
  const before = TRANSCRIPT.slice(0, from).filter(row => row.dir === "in" && SETTING_METHODS.has(row.msg.method)).map(row => row.msg);
  assertProbeIsolatesToolList(verifySettingRequests(before, transcriptOutputs));
  const turn = TRANSCRIPT.slice(from).map(row => row.msg);
  const end = turn.findIndex(turnEnded);
  assert.ok(end > 0, "the probe turn completed");
  const toolCalls = turn.slice(0, end).filter(m => note(m)?.type === "tool_call").map(m => note(m).toolUse.name);
  assert.ok(!toolCalls.includes("Create"), `no Create call in the probe turn: ${toolCalls}`);
});

function openSession(cwd, extraArgs, env) {
  const child = spawn("droid", ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc", "--cwd", cwd, ...extraArgs],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"], timeout: LIVE_TIMEOUT_MS });
  const outputs = [], waiters = new Set();
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", line => {
    if (!line.trim()) return;
    outputs.push(JSON.parse(line));
    for (const check of waiters) check();
  });
  const closed = new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal })));
  const waitFor = (predicate, from, ms, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`timed out waiting for ${label}; stderr: ${stderr.slice(-800)}`)); }, ms);
    function check() {
      const hit = outputs.slice(from).find(predicate);
      if (!hit) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolve(hit);
    }
    waiters.add(check);
    check();
  });
  const request = async (method, params) => {
    const id = crypto.randomUUID(), mark = outputs.length;
    child.stdin.write(`${JSON.stringify({ ...ENVELOPE, id, method, params })}\n`);
    const response = await waitFor(m => isResponse(m, id), mark, 60000, `${method} response`);
    return { id, mark, response };
  };
  const close = async () => {
    child.stdin.end();
    const killer = setTimeout(() => child.kill("SIGTERM"), 10000);
    const exit = await closed;
    clearTimeout(killer);
    return exit;
  };
  return { outputs, request, waitFor, close };
}

function liveRepo() {
  const cwd = makeTempDir("droid-steering-repo-");
  fs.writeFileSync(path.join(cwd, "README.md"), "hi\n");
  return cwd;
}

test("live: real Droid confirms every captured setting request and the read-only list refuses Create", live, async () => {
  const cwd = liveRepo();
  const session = openSession(cwd, [], smokeEnv({ fenced: true }));
  try {
    const sent = [];
    for (const { method, params } of transcriptRequests.filter(request => SETTING_METHODS.has(request.method))) {
      const replayed = JSON.parse(JSON.stringify(params).replaceAll("$CWD", cwd));
      const { id, mark } = await session.request(method, replayed);
      if (method === "droid.update_session_settings") await session.waitFor(m => note(m)?.requestId === id && note(m).type === "settings_updated", mark, 30000, `${method} confirmation`);
      sent.push({ id, method, params: replayed });
    }
    const replay = verifySettingRequests(sent, session.outputs);
    assertYesRowsConfirmed(replay);
    if (!yes("tool list")) return;
    assertProbeIsolatesToolList(replay);
    const probe = transcriptRequests.find(request => request.method === "droid.add_user_message" && request.params.text.includes(PROBE_FILE));
    const { mark } = await session.request(probe.method, probe.params);
    const end = await session.waitFor(turnEnded, mark, 240000, "the probe turn");
    assert.equal(note(end).reason, "completed");
    const toolCalls = session.outputs.slice(mark).filter(m => note(m)?.type === "tool_call").map(m => note(m).toolUse.name);
    assert.ok(!toolCalls.includes("Create"), `no Create call: ${toolCalls}`);
    assert.ok(!fs.existsSync(path.join(cwd, PROBE_FILE)), `${PROBE_FILE} was not written`);
  } finally {
    await session.close();
  }
});

test("live: --settings sets the session defaults in input mode exactly when its row says yes", live, async () => {
  const cwd = liveRepo(), env = smokeEnv({ fenced: true });
  const wanted = { modelId: "glm-5.3-flash", reasoningEffort: "low", autonomyLevel: "low" };
  const file = path.join(makeTempDir("droid-steering-settings-"), "settings.json");
  fs.writeFileSync(file, JSON.stringify({ sessionDefaultSettings: { model: wanted.modelId, reasoningEffort: wanted.reasoningEffort, autonomyLevel: wanted.autonomyLevel } }));
  const initialSettings = async extraArgs => {
    const session = openSession(cwd, extraArgs, env);
    try {
      const { response } = await session.request("droid.initialize_session", { machineId: "probe", cwd });
      assert.ok(!response.error, JSON.stringify(response.error));
      return Object.fromEntries(Object.keys(wanted).map(key => [key, response.result.settings[key]]));
    } finally {
      await session.close();
    }
  };
  const baseline = await initialSettings([]);
  assert.notDeepEqual(baseline, wanted, "without the file the session must start elsewhere, or the probe proves nothing");
  const withFile = await initialSettings(["--settings", file]);
  assert.equal(isDeepStrictEqual(withFile, wanted), yes(SETTINGS_ROW), `with --settings: ${JSON.stringify(withFile)}`);
});
