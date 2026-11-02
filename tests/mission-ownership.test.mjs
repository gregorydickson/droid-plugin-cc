import test from "node:test";
import assert from "node:assert/strict";
import { missionProcesses } from "./mission-ownership.mjs";

const CWD = "/tmp/mission-cwd", OTHER_CWD = "/tmp/other-cwd", RUNNER = 100, SELF = 200, EXEC = 300, SESSION = "11111111-2222-3333-4444-555555555555";
const proc = (pid, ppid, command) => ({ pid, ppid, pgid: pid, command });
const table = {
  runner: proc(RUNNER, 1, "node --test"),
  self: proc(SELF, RUNNER, "node mission-protocol.test.mjs"),
  exec: proc(EXEC, SELF, `droid exec --mission --cwd ${CWD}`),
  execChild: proc(301, EXEC, "/bin/sh -c sleep 120"),
  ownProbe: proc(310, SELF, "/usr/local/bin/droid doctor"),
  siblingTest: proc(400, RUNNER, "node tool-fence.test.mjs"),
  siblingDroid: proc(401, 400, "/usr/local/bin/droid exec --list-tools"),
  siblingNamed: proc(402, 400, `/usr/local/bin/droid exec -s ${SESSION}`),
  daemonWorker: proc(500, 1, `/home/u/.local/bin/droid exec -s ${SESSION}`),
  daemonNamedOnly: proc(501, 1, `node worker ${SESSION}`),
  detachedSiblingDroid: proc(450, 1, `/usr/local/bin/droid exec --cwd ${OTHER_CWD} --mission`),
  leakedTaskWorker: proc(700, 1, "node task-worker.mjs"),
  leakedMissionExec: proc(701, 700, `droid exec --cwd ${OTHER_CWD} --mission`),
  leakedMissionWorker: proc(702, 701, "droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc"),
  unrelated: proc(600, 1, "/usr/bin/vim")
};
const procs = Object.values(table);
const pids = list => new Set(list.map(entry => entry.pid));
const adopted = (baseline = new Set(), opts = {}) =>
  pids(missionProcesses(procs, { rootPid: EXEC, baseline, sessionId: SESSION, cwd: CWD, selfPid: SELF, runnerPid: RUNNER, ...opts }));

test("mission ownership keeps the exec tree and daemon-spawned workers", () => {
  const owned = adopted();
  for (const key of ["exec", "execChild", "ownProbe", "daemonWorker", "daemonNamedOnly"]) assert.ok(owned.has(table[key].pid), key);
});

test("mission ownership never adopts a process under a sibling test file", () => {
  const owned = adopted();
  for (const key of ["siblingTest", "siblingDroid", "siblingNamed", "detachedSiblingDroid", "leakedMissionExec", "leakedMissionWorker"]) assert.ok(!owned.has(table[key].pid), key);
  assert.ok(!owned.has(table.unrelated.pid));
});

test("a cwd-less worker inherits the workspace of its nearest cwd-naming ancestor", () => {
  const owned = adopted();
  assert.ok(!owned.has(table.leakedMissionWorker.pid));
  assert.ok(owned.has(table.execChild.pid));
  assert.ok(owned.has(table.daemonWorker.pid));
});

test("mission ownership still skips baseline processes outside the exec tree", () => {
  const owned = adopted(new Set([table.daemonWorker.pid]));
  assert.ok(!owned.has(table.daemonWorker.pid));
  assert.ok(owned.has(table.exec.pid));
});

test("an orphaned runner pid does not turn every process into a sibling", () => {
  const owned = adopted(new Set(), { runnerPid: 1 });
  assert.ok(owned.has(table.daemonWorker.pid));
  assert.ok(owned.has(table.siblingDroid.pid));
});
