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
