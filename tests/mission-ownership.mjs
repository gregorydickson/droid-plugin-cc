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

// Processes the mission owns: the exec's descendants, plus any process naming the
// mission session id or any Droid or factoryd binary started after the baseline.
// Two kinds of evidence say a process belongs to another test: ancestry (a descendant
// of `runnerPid`, the shared test runner, that is not a descendant of `selfPid`) and an
// explicit `--cwd` other than the mission's, which catches background work a sibling
// detached from the runner. Daemon-spawned workers name neither, so they stay owned.
export function missionProcesses(procs, { rootPid, baseline, sessionId, cwd, selfPid = process.pid, runnerPid = process.ppid }) {
  const tree = withDescendants(procs, [rootPid]);
  const own = withDescendants(procs, [selfPid]);
  const siblings = runnerPid > 1 ? withDescendants(procs, [runnerPid]) : new Set();
  const foreign = proc => (siblings.has(proc.pid) && !own.has(proc.pid)) || (namedCwd(proc) ?? cwd) !== cwd;
  return procs.filter(proc => tree.has(proc.pid) || !baseline.has(proc.pid) && !foreign(proc) && (
    (sessionId && proc.command.includes(sessionId)) || isDroidBinary(proc)));
}
