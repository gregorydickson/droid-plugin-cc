import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run, SMOKE_MODEL } from "./helpers.mjs";

// Live probe of `droid exec --mission`; docs/missions.md records what it found.
// Missions spend credits, so each scenario runs once. DROID_MISSION_REPORT=<dir>
// saves what a live run observed; DROID_MISSION_REPLAY=<dir> re-checks the doc
// against saved reports without starting a mission.
const REPLAY = process.env.DROID_MISSION_REPLAY;
const REPORT = process.env.DROID_MISSION_REPORT;
const gate = { skip: process.env.DROID_SMOKE_MISSION !== "1" && !REPLAY, timeout: 600000 };
const DOC = new URL("../docs/missions.md", import.meta.url);
const GOAL = "Create hello.txt containing the word hi, then stop.";
const CANCEL_GOAL = "Do not create or edit any file yourself. Start exactly one worker for this mission. "
  + "The worker must first run the shell command `sleep 120`, then create hello.txt containing the word hi.";
const RUN_LIMIT_MS = 540000;
const SAMPLE_MS = 2000;
const AFTER_CANCEL_MS = 10000;
const CANCEL_FALLBACK_MS = 240000;
const FACTORY_HOME = path.join(process.env.FACTORY_HOME_OVERRIDE ?? os.homedir(), ".factory");
const observed = {};

function missionRepo() {
  const cwd = fs.realpathSync(makeTempDir("droid-mission-"));
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "mission probe\n");
  run("git", ["add", "."], { cwd }); run("git", ["commit", "-m", "init"], { cwd });
  assert.equal(run("git", ["remote"], { cwd }).stdout.trim(), "", "mission repo must have no remote");
  return cwd;
}

function eventName(event, format) {
  if (format === "stream-json") return event.subtype ? `${event.type}/${event.subtype}` : String(event.type);
  if (event.method === "droid.session_notification") return String(event.params?.notification?.type);
  return String(event.method ?? event.type);
}

function snapshot() {
  const out = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8", timeout: 10000 }).stdout ?? "";
  return out.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }] : [];
  });
}

// Processes the mission owns: the exec's descendants, any process naming the
// mission session id, and any Droid or factoryd binary started after the baseline.
function missionProcesses(procs, rootPid, baseline, sessionId) {
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const proc of procs) if (!tree.has(proc.pid) && tree.has(proc.ppid)) { tree.add(proc.pid); grew = true; }
  }
  return procs.filter(proc => tree.has(proc.pid) || !baseline.has(proc.pid) && (
    (sessionId && proc.command.includes(sessionId)) || isDroidBinary(proc)));
}

const isDroidBinary = proc => /(^|\/)(droid|factoryd)$/.test(proc.command.split(" ")[0]);

// Worker processes: a Droid or factoryd binary other than the exec itself, or a
// process naming the mission session id, plus everything they spawned. MCP
// servers and tool commands the orchestrator runs are not workers.
function workerProcesses(lineage, rootPid) {
  const workers = new Set(lineage.filter(proc => proc.pid !== rootPid && (proc.hasSessionId || isDroidBinary(proc))).map(proc => proc.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const proc of lineage) if (!workers.has(proc.pid) && workers.has(proc.ppid)) { workers.add(proc.pid); grew = true; }
  }
  return lineage.filter(proc => workers.has(proc.pid));
}

// Session files Droid wrote for this cwd, with each one's mission role.
function missionSessions(cwd) {
  const dir = path.join(FACTORY_HOME, "sessions", cwd.replace(/[/\\]/g, "-"));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith(".settings.json")).map(name => {
    const settings = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    const tag = (settings.tags ?? []).find(entry => entry.name === "mission-session");
    const sessionId = name.replace(/\.settings\.json$/, "");
    const log = path.join(dir, `${sessionId}.jsonl`);
    return { sessionId, role: tag?.metadata?.role ?? null, missionId: tag?.metadata?.missionId ?? null,
      logMtimeMs: fs.existsSync(log) ? fs.statSync(log).mtimeMs : null };
  });
}

function save(name, record) {
  if (!REPORT) return;
  fs.mkdirSync(REPORT, { recursive: true });
  fs.writeFileSync(path.join(REPORT, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

// Runs one mission and resolves with every event, the exit, and with `cancel`
// the processes seen before SIGTERM to the exec's group and those alive after.
function runMission(format, { goal = GOAL, cancel = false } = {}) {
  const cwd = missionRepo();
  const prompt = path.join(makeTempDir("droid-mission-prompt-"), "prompt.md");
  fs.writeFileSync(prompt, goal);
  const baseline = new Set(snapshot().map(proc => proc.pid));
  const args = ["exec", "--mission", "--auto", "high", "-m", SMOKE_MODEL, "-r", "high", "--worker-model", SMOKE_MODEL,
    "--validator-model", SMOKE_MODEL, "--output-format", format, "--cwd", cwd, "-f", prompt];
  const started = Date.now();
  const child = spawn("droid", args, { cwd, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const record = { format, args, cwd, events: [], nonJson: [], stderr: "", exitCode: null, signal: null,
    timedOut: false, helloTxt: null, sessionId: null, lineage: [], sessions: [], cancel: null };
  const lineage = new Map();
  let exited = false, cancelled = false;
  const sample = () => {
    for (const proc of missionProcesses(snapshot(), child.pid, baseline, record.sessionId)) {
      const seen = lineage.get(proc.pid) ?? { ...proc, inExecGroup: proc.pgid === child.pid, firstSeenMs: Date.now() - started };
      seen.hasSessionId ||= Boolean(record.sessionId && proc.command.includes(record.sessionId));
      lineage.set(proc.pid, seen);
    }
  };
  const killGroup = signal => { try { process.kill(-child.pid, signal); } catch { /* group gone */ } };
  const workerSessions = () => missionSessions(cwd).filter(session => session.sessionId !== record.sessionId && session.role !== "orchestrator");
  const workerStarted = () => workerProcesses([...lineage.values()], child.pid).length > 0 || workerSessions().length > 0;
  const sampler = setInterval(() => {
    sample();
    if (!cancel || cancelled || exited || !(workerStarted() || Date.now() - started > CANCEL_FALLBACK_MS)) return;
    cancelled = true;
    record.cancel = { sentAtMs: Date.now() - started, sentAtEpochMs: Date.now(), exitedBeforeCancel: false,
      workersAtCancel: workerProcesses([...lineage.values()], child.pid).map(proc => proc.pid), sessionsAtCancel: missionSessions(cwd) };
    killGroup("SIGTERM");
  }, SAMPLE_MS);
  const limit = setTimeout(() => { record.timedOut = true; killGroup("SIGKILL"); }, RUN_LIMIT_MS);
  child.stderr.on("data", data => { record.stderr = (record.stderr + data).slice(-16384); });
  createInterface({ input: child.stdout }).on("line", line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { record.nonJson.push(line.slice(0, 500)); return; }
    const session = event.session_id ?? event.params?.sessionId ?? event.result?.sessionId ?? null;
    record.sessionId ??= session;
    record.events.push({ name: eventName(event, format), session, tool: event.toolName ?? undefined, atMs: Date.now() - started });
  });
  return new Promise(resolve => {
    child.on("close", async (code, signal) => {
      exited = true; clearInterval(sampler); clearTimeout(limit);
      Object.assign(record, { exitCode: code, signal });
      const hello = path.join(cwd, "hello.txt");
      record.helloTxt = fs.existsSync(hello) ? fs.readFileSync(hello, "utf8") : null;
      if (cancel && !cancelled) record.cancel = { exitedBeforeCancel: true };
      if (cancelled) {
        await new Promise(done => setTimeout(done, AFTER_CANCEL_MS));
        sample();
        const alive = snapshot();
        const owned = [...lineage.values()];
        const tracked = [owned.find(proc => proc.pid === child.pid), ...workerProcesses(owned, child.pid)].filter(Boolean);
        const processes = tracked.filter(proc => alive.some(now => now.pid === proc.pid && now.command === proc.command))
          .map(({ pid, ppid, pgid, command }) => ({ pid, ppid, pgid, command }));
        const sessions = workerSessions().filter(session => session.logMtimeMs > record.cancel.sentAtEpochMs + AFTER_CANCEL_MS / 2)
          .map(({ sessionId, role }) => ({ sessionId, role }));
        record.cancel.survivors = [...processes, ...sessions];
        for (const { pid } of processes) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      }
      record.lineage = [...lineage.values()];
      record.sessions = missionSessions(cwd);
      resolve(record);
    });
  });
}

async function observe(name, format, options) {
  if (REPLAY) return JSON.parse(fs.readFileSync(path.join(REPLAY, `${name}.json`), "utf8"));
  const record = await runMission(format, options);
  save(name, record);
  return record;
}

const eventsOf = record => record.events.map(event => event.name);

function partial(record) {
  return `exit=${record.exitCode} signal=${record.signal} timedOut=${record.timedOut} events=${eventsOf(record).join(",")} stderr=${record.stderr.slice(-2000)}`;
}

// The last two non-empty lines of docs/missions.md are the recorded findings.
function readFindings() {
  const lines = fs.readFileSync(DOC, "utf8").split("\n").filter(line => line.trim());
  const [completionLine, cancelLine] = lines.slice(-2);
  const completion = completionLine?.match(/^Completion: (stream-jsonrpc|stream-json) (\S+)$/);
  const cancel = cancelLine?.match(/^Cancel: (full|orchestrator-only)$/);
  assert.ok(completion, `docs/missions.md must end with a Completion: line, saw ${completionLine}`);
  assert.ok(cancel, `docs/missions.md must end with a Cancel: line, saw ${cancelLine}`);
  return { completion: { format: completion[1], event: completion[2] }, cancel: cancel[1] };
}

test("one-shot stream-jsonrpc rejects --mission before starting a session", gate, async () => {
  const record = await observe("completion-stream-jsonrpc", "stream-jsonrpc");
  assert.notEqual(record.exitCode, 0, partial(record));
  assert.match(record.stderr, /--mission is not supported with one-shot --output-format stream-jsonrpc/);
  assert.deepEqual(record.events, []);
});

test("a mission on stream-json creates hello.txt and exits 0", gate, async () => {
  const record = await observe("completion-stream-json", "stream-json");
  observed["stream-json"] = record;
  assert.equal(record.timedOut, false, partial(record));
  assert.equal(record.exitCode, 0, partial(record));
  assert.match(record.helloTxt ?? "", /hi/, partial(record));
  assert.ok(record.sessions.some(session => session.sessionId === record.sessionId && session.role === "orchestrator"),
    `stream session ${record.sessionId} is not a mission orchestrator: ${JSON.stringify(record.sessions)}`);
});

test("the completion event named in docs/missions.md is the last event before exit", gate, () => {
  const { completion } = readFindings();
  const record = observed[completion.format];
  assert.ok(record, `no successful ${completion.format} mission was observed`);
  assert.equal(eventsOf(record).at(-1), completion.event, partial(record));
});

test("SIGTERM to the mission's process group leaves survivors iff the doc says orchestrator-only", gate, async () => {
  const record = await observe("cancel", "stream-json", { goal: CANCEL_GOAL, cancel: true });
  assert.equal(record.timedOut, false, partial(record));
  assert.equal(record.cancel?.exitedBeforeCancel, false, `mission exited before it was cancelled: ${partial(record)}`);
  assert.ok(record.lineage.some(proc => record.cancel.workersAtCancel.includes(proc.pid) && isDroidBinary(proc)),
    `no Droid worker process was running when SIGTERM was sent: ${JSON.stringify(record.lineage.map(proc => proc.command))}`);
  const { cancel } = readFindings();
  if (cancel === "full") assert.deepEqual(record.cancel.survivors, [], "doc says Cancel: full but processes survived");
  else assert.notDeepEqual(record.cancel.survivors, [], "doc says Cancel: orchestrator-only but nothing survived");
});
