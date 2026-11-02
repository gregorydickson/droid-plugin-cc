import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Shared by the live mission probes (mission-protocol.test.mjs) and the plugin's live mission tests (mission.test.mjs).
export const FACTORY_HOME = path.join(process.env.FACTORY_HOME_OVERRIDE ?? os.homedir(), ".factory");

// A mission is stuck when nothing it owns has written for MISSION_STALL_MS: a GLM mission runs its auto-injected
// validators as further workers, so its length varies run to run while its quiet spells stay short
// (docs/missions.md). MISSION_CEILING_MS only stops a mission that keeps writing without finishing.
export const MISSION_STALL_MS = 180000;
export const MISSION_CEILING_MS = 1500000;

// The orchestrator must write the mission's own files before StartMissionRun can spawn a worker, so the
// goal forbids it only the work itself; the worker's sleep keeps it alive past the first sample that sees it.
export const MISSION_CANCEL_GOAL = "Run this as a mission with exactly one feature, implemented by exactly one worker. "
  + "You may write the mission's planning files, but you must not run the sleep or create hello.txt yourself. "
  + "The worker must first run the shell command `sleep 600`, then create hello.txt containing the word hi.";

export const sessionsDir = cwd => path.join(FACTORY_HOME, "sessions", cwd.replace(/[/\\]/g, "-"));

// The newest write to anything the mission keeps on disk: every session log for its cwd (orchestrator,
// workers, validators and their subagents) and the mission's own directory.
export function lastMissionWriteMs(cwd, sessionId) {
  const dirs = [sessionsDir(cwd), ...(sessionId ? [path.join(FACTORY_HOME, "missions", sessionId)] : [])];
  let latest = 0;
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) { try { latest = Math.max(latest, fs.statSync(path.join(dir, name)).mtimeMs); } catch { /* removed */ } }
  }
  return latest;
}

export const isDroidBinary = proc => /(^|\/)(droid|factoryd)$/.test(proc.command.split(" ")[0]);

// The pids in `seeds` plus every process descended from them.
export function withDescendants(procs, seeds) {
  const tree = new Set(seeds);
  for (let grew = true; grew;) {
    grew = false;
    for (const proc of procs) if (!tree.has(proc.pid) && tree.has(proc.ppid)) { tree.add(proc.pid); grew = true; }
  }
  return tree;
}

// The directory a process was told to work in, when its command line names one.
const namedCwd = proc => proc.command.match(/(?:^|\s)--cwd[= ](\S+)/)?.[1] ?? null;

// The workspace of a process: the directory named by itself or by its nearest ancestor that names one.
function inheritedCwd(byPid, proc) {
  for (let seen = new Set(), at = proc; at && !seen.has(at.pid); at = byPid.get(at.ppid)) {
    seen.add(at.pid);
    const named = namedCwd(at);
    if (named) return named;
  }
  return null;
}

// Processes the mission owns: the exec's descendants, plus any process naming the
// mission session id or any Droid or factoryd binary started after the baseline.
// Two kinds of evidence say a process belongs to another test: ancestry (a descendant
// of `runnerPid`, the shared test runner, that is not a descendant of `selfPid`) and an
// workspace (its own `--cwd`, else its nearest ancestor's) other than the mission's, which
// catches background work a sibling detached from the runner and the workers of such work.
// Daemon-spawned workers with no cwd-naming ancestor name neither, so they stay owned.
export function missionProcesses(procs, { rootPid, baseline, sessionId, cwd, selfPid = process.pid, runnerPid = process.ppid }) {
  const tree = withDescendants(procs, [rootPid]);
  const own = withDescendants(procs, [selfPid]);
  const siblings = runnerPid > 1 ? withDescendants(procs, [runnerPid]) : new Set();
  const byPid = new Map(procs.map(proc => [proc.pid, proc]));
  const foreign = proc => (siblings.has(proc.pid) && !own.has(proc.pid)) || (inheritedCwd(byPid, proc) ?? cwd) !== cwd;
  return procs.filter(proc => tree.has(proc.pid) || !baseline.has(proc.pid) && !foreign(proc) && (
    (sessionId && proc.command.includes(sessionId)) || isDroidBinary(proc)));
}
