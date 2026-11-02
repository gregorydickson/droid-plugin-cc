import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { writeExecutable } from "./helpers.mjs";

// Session-inclusive usage after turns 1 and 2 of one session (droid 0.238.0, haiku, live runs).
// Turn N > 2 extends the same per-turn increment.
export const SESSION_USAGE = [
  { inputTokens: 9, outputTokens: 216, cacheReadTokens: 0, cacheCreationTokens: 5322, thinkingTokens: 158, factoryCredits: 3097 },
  { inputTokens: 18, outputTokens: 275, cacheReadTokens: 0, cacheCreationTokens: 10760, thinkingTokens: 189, factoryCredits: 5938 }
];
export const DOCTOR_FIXTURE = fileURLToPath(new URL("./fixtures/droid-doctor-1.1.0.json", import.meta.url));
export const HELP_FIXTURE = fileURLToPath(new URL("./fixtures/droid-exec-help-0.238.0.txt", import.meta.url));

export function installFakeDroid(binDir, behavior = "review-ok", worker = false) {
  const statePath = path.join(binDir, "fake-droid-state.json");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const STATE_PATH = ${JSON.stringify(statePath)};
const SESSION_USAGE = ${JSON.stringify(SESSION_USAGE)};
const BEHAVIOR = ${JSON.stringify(behavior)};
const WORKER = ${JSON.stringify(worker)};
const args = process.argv.slice(2);
const arg = flag => args[args.indexOf(flag) + 1];
if (args[0] === "--version") { console.log("droid-cli test " + (process.env.FAKE_DROID_VERSION ?? "1.1.0")); process.exit(0); }
if (args[0] === "exec" && args.includes("--help")) { process.stdout.write(fs.readFileSync(${JSON.stringify(HELP_FIXTURE)}, "utf8")); process.exit(0); }
if (args[0] === "doctor") {
  const mode = process.env.FAKE_DROID_DOCTOR ?? "ok";
  if (mode === "hang") { setInterval(() => {}, 1000); return; }
  if (mode === "fail-exit") { process.stderr.write("doctor crashed\\n"); process.exit(1); }
  else if (mode === "invalid") { process.stdout.write("not json {"); process.exit(0); }
  else {
    const report = JSON.parse(fs.readFileSync(${JSON.stringify(DOCTOR_FIXTURE)}, "utf8"));
    if (mode === "ok") report.results = report.results.filter(result => result.status === "pass");
    if (mode === "no-auth") report.results = report.results.filter(result => !result.id.startsWith("auth."));
    if (mode === "auth-fail") report.results = report.results.map(result => result.id === "auth.verify" ? { ...result, status: "fail", detail: "token rejected", remediation: "Run /login" } : result);
    process.stdout.write(JSON.stringify(report));
    process.exit(0);
  }
}
const FORMAT = arg("--output-format");
if (args[0] !== "exec" || !["stream-jsonrpc", "stream-json"].includes(FORMAT)) process.exit(2);
// The real CLI's flag check (droid 0.238.0), so a bad argv fails here as it does live.
if (FORMAT === "stream-jsonrpc" && arg("--input-format") !== "stream-jsonrpc") {
  for (const flag of ["--session-id", "--fork"]) if (args.includes(flag)) {
    process.stderr.write("Invalid flags: " + flag + " is not supported with one-shot --output-format stream-jsonrpc. Use --output-format stream-json, or drive the session with --input-format stream-jsonrpc.\\n");
    process.exit(1);
  }
}
if (args.includes("--mission") && FORMAT !== "stream-json") {
  process.stderr.write("Invalid flags: --mission is not supported with one-shot --output-format stream-jsonrpc. Use --output-format stream-json, or drive the session with --input-format stream-jsonrpc.\\n");
  process.exit(1);
}
const loadState = () => fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH)) : { threads: [], threadRequests: [], execStarts: 0 };
if (arg("--input-format") === "stream-jsonrpc") runInputSession();
else {
const prompt = fs.readFileSync(arg("-f"), "utf8");
const state = loadState();
state.execStarts++;
const resume = args.includes("--session-id");
const threadId = resume ? arg("--session-id") : crypto.randomUUID();
if (!resume) state.threads.push({ id: threadId, cwd: process.cwd() });
state.sessionTurns = { ...state.sessionTurns, [threadId]: (state.sessionTurns?.[threadId] ?? 0) + 1 };
const turnNumber = state.sessionTurns[threadId];
const [first, second] = SESSION_USAGE;
const sessionUsage = Object.fromEntries(Object.keys(first).map(key => [key, first[key] + (turnNumber - 1) * (second[key] - first[key])]));
const turnId = crypto.randomUUID();
const systemPrompt = args.includes("--append-system-prompt-file") ? fs.readFileSync(arg("--append-system-prompt-file"), "utf8") : null;
state.lastTurnStart = { threadId, turnId, prompt, systemPrompt, model: args.includes("-m") ? arg("-m") : null, effort: args.includes("-r") ? arg("-r") : null };
state.turns = [...(state.turns || []), state.lastTurnStart];
state.threadRequests.push({ method: resume ? "resume" : "start", threadId, cwd: process.cwd(), args });
fs.writeFileSync(STATE_PATH, JSON.stringify(state));
const envelope = { jsonrpc: "2.0", factoryApiVersion: "1.0.0", factoryProtocolVersion: "1.257.0" };
const send = msg => process.stdout.write(JSON.stringify({ ...envelope, ...msg }) + "\\n");
const line = event => process.stdout.write(JSON.stringify({ ...event, session_id: threadId }) + "\\n");
let streamText = "";
// stream-json has no deltas or turn-completed notification: it emits the whole
// assistant message, then one completion event with snake_case usage.
const notify = FORMAT === "stream-jsonrpc"
  ? notification => send({ type: "notification", method: "droid.session_notification", params: { sessionId: threadId, notification } })
  : n => {
    if (n.type === "error") line({ type: "error", message: n.message });
    if (n.type === "assistant_text_delta") streamText += n.textDelta;
    if (n.type === "assistant_text_complete") line({ type: "message", role: "assistant", id: n.messageId, text: streamText });
    if (n.type === "agent_turn_completed") line({ type: "completion", finalText: streamText, numTurns: 1, usage: { input_tokens: n.tokenUsage.inputTokens, output_tokens: n.tokenUsage.outputTokens, cache_read_input_tokens: n.tokenUsage.cacheReadTokens, cache_creation_input_tokens: n.tokenUsage.cacheCreationTokens, factory_credits: n.tokenUsage.factoryCredits, thinking_tokens: n.tokenUsage.thinkingTokens, ttft_ms: 1629 } });
  };
if (FORMAT === "stream-jsonrpc") send({ type: "response", id: "init", result: { sessionId: threadId } });
else line({ type: "system", subtype: "init", cwd: process.cwd(), tools: [] });
if (BEHAVIOR === "auth-run-fails") { notify({ type: "error", message: "Authentication failed: sign in to Droid" }); process.exit(1); }
if (BEHAVIOR === "stubborn-task") {
  const child = require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  state.rootPid = process.pid; state.descendantPid = child.pid;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);
}
else if (BEHAVIOR === "malformed") { console.log("not JSON"); setTimeout(() => {}, 10000); }
else if (BEHAVIOR === "no-completion") process.exit(0);
else if (args.includes("--mission")) {
  // The event sequence recorded in docs/missions.md: user echo, reasoning, a tool call and its result, the assistant message, then one completion.
  line({ type: "message", role: "user", id: "echo", text: prompt });
  line({ type: "reasoning", id: "think", text: "Plan the mission." });
  line({ type: "tool_call", id: "call-1", toolId: "Create", toolName: "Create", parameters: { file_path: "hello.txt" } });
  line({ type: "tool_result", id: "call-1", toolId: "Create", isError: false, value: "created" });
  line({ type: "message", role: "assistant", id: "final", text: "Mission finished." });
  line({ type: "completion", finalText: "Mission finished.", numTurns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
}
else {
let payload;
const paused = prompt.includes("NEED_ANSWER") && !prompt.includes("Answer to your stop report:");
if (WORKER) {
  payload = prompt.includes('"evidence"') ? JSON.stringify({ verdict: BEHAVIOR === "invalid-claim-verdict" ? "maybe" : "holds", evidence: "source.txt:1@pinned" })
    : prompt.includes('"awaiting-answer"') && prompt.includes('"anyOf"')
    ? JSON.stringify({ state: paused ? "awaiting-answer" : "completed", result: paused ? null : { count: 2 }, question: paused ? "Which option?" : null, draftAnswer: paused ? "yes" : null, facts: [], itemsHeld: [] })
    : paused ? JSON.stringify({ question: "Which option?", draftAnswer: "yes", facts: [], itemsHeld: [], state: "awaiting-answer" }) : JSON.stringify({ count: 2 });
} else if (prompt.includes('"verdict"')) payload = structuredReviewPayload(prompt);
else if (prompt.startsWith("Review code changes")) payload = nativeReviewText(prompt.includes("branch") ? { type: "baseBranch", branch: "main" } : { type: "uncommittedChanges" });
else payload = taskPayload(prompt, resume);
if (BEHAVIOR === "invalid-json" || (BEHAVIOR === "repair-once" && !prompt.startsWith("Your previous answer"))) payload = "not valid json";
if (BEHAVIOR === "repair-once" && prompt.startsWith("Your previous answer")) payload = '{"count":2}';
// A run that edits the workspace, as a shell command under --auto medium can.
if (BEHAVIOR === "writes-file") fs.writeFileSync(require("node:path").join(process.cwd(), "droid-wrote.txt"), "written by droid");
const finish = () => {
  if (BEHAVIOR === "warning-success") notify({ type: "error", message: "Temporary model error" });
  if (BEHAVIOR === "blank-lines") console.log("  ");
  notify({ type: "assistant_text_delta", messageId: "answer", blockIndex: 0, textDelta: payload.slice(0, 7) });
  notify({ type: "assistant_text_delta", messageId: "answer", blockIndex: 0, textDelta: payload.slice(7) });
  notify({ type: "assistant_text_complete", messageId: "answer", blockIndex: 0 });
  if (BEHAVIOR === "text-then-hang") return;
  notify({ type: "agent_turn_completed", reason: "completed", turnId, tokenUsage: sessionUsage });
  if (BEHAVIOR === "trailing-prose") console.log("late diagnostic");
};
if (BEHAVIOR === "interruptible-slow-task") setTimeout(finish, 5000);
else if (BEHAVIOR === "slow-task") setTimeout(finish, 400);
else finish();
}
}

// A held-open JSON-RPC input session (docs/live-steering.md): one NDJSON request per stdin
// line, every request recorded in state.inputRequests. initialize_session echoes the settings
// it was given, minus any named in FAKE_DROID_IGNORE_SETTINGS. A message sent while a turn runs
// is folded into that turn, as droid does, so each completion answers every message it saw.
// FAKE_DROID_INPUT=exit quits on initialize without a completion; =permission asks the client
// for a permission after initializing; =hold keeps running after stdin closes; =orphan starts a
// SIGTERM-ignoring descendant (state.inputDescendantPid) that outlives the session. FAKE_DROID_TURN_MS
// sets how long a turn runs.
function runInputSession() {
  for (const flag of ["--tag", "--only-tools", "--auto", "--add-tools", "-m", "-r", "-f", "--session-id"]) if (args.includes(flag)) {
    process.stderr.write("fake droid: " + flag + " is ignored with --input-format stream-jsonrpc\\n");
    process.exit(3);
  }
  const sessionId = crypto.randomUUID();
  const update = change => { const state = loadState(); change(state); fs.writeFileSync(STATE_PATH, JSON.stringify(state)); };
  update(state => {
    state.execStarts++; state.inputRequests = []; state.inputPid = process.pid; state.inputArgs = args;
    state.threads.push({ id: sessionId, cwd: process.cwd() });
  });
  const ignored = new Set((process.env.FAKE_DROID_IGNORE_SETTINGS ?? "").split(",").filter(Boolean));
  const mode = process.env.FAKE_DROID_INPUT ?? "";
  const turnMs = Number(process.env.FAKE_DROID_TURN_MS ?? 50);
  const envelope = { jsonrpc: "2.0", factoryApiVersion: "1.0.0", factoryProtocolVersion: "1.289.0" };
  const send = msg => process.stdout.write(JSON.stringify({ ...envelope, ...msg }) + "\\n");
  const notify = notification => send({ type: "notification", method: "droid.session_notification", params: { sessionId, notification } });
  const [first, second] = SESSION_USAGE;
  const sessionUsage = n => Object.fromEntries(Object.keys(first).map(key => [key, first[key] + (n - 1) * (second[key] - first[key])]));
  let turns = 0, running = null;
  const completeTurn = () => {
    const { turnId, texts } = running;
    running = null;
    turns++;
    update(state => { state.sessionTurns = { ...state.sessionTurns, [sessionId]: turns }; });
    const payload = BEHAVIOR === "repair-once" || BEHAVIOR === "invalid-json" ? "not valid json"
      : texts.some(text => text.includes("Return only JSON")) ? JSON.stringify({ count: 2 }) : "Answered: " + texts.join(" + ");
    const messageId = "answer-" + turns;
    notify({ type: "assistant_text_delta", messageId, blockIndex: 0, textDelta: payload.slice(0, 5) });
    notify({ type: "assistant_text_delta", messageId, blockIndex: 0, textDelta: payload.slice(5) });
    notify({ type: "assistant_text_complete", messageId, blockIndex: 0 });
    const cumulative = sessionUsage(turns), previous = turns > 1 ? sessionUsage(turns - 1) : null;
    const tokenUsage = Object.fromEntries(Object.entries(cumulative).map(([key, value]) => [key, value - (previous?.[key] ?? 0)]));
    notify({ type: "agent_turn_completed", reason: "completed", turnId, tokenUsage, cumulativeTokenUsage: cumulative });
  };
  const lines = require("node:readline").createInterface({ input: process.stdin });
  lines.on("line", raw => {
    if (!raw.trim()) return;
    const msg = JSON.parse(raw);
    update(state => { state.inputRequests.push(msg); });
    if (msg.type !== "request") return;
    if (msg.method === "droid.initialize_session") {
      if (mode === "exit") process.exit(0);
      const settings = Object.fromEntries(Object.entries(msg.params).filter(([key]) => !["cwd", "machineId"].includes(key) && !ignored.has(key)));
      send({ type: "response", id: msg.id, result: { sessionId, session: { messages: [] }, settings } });
      if (mode === "permission") send({ type: "request", id: "permission-1", method: "droid.request_permission", params: {} });
      if (mode === "orphan") {
        const descendant = require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
        update(state => { state.inputDescendantPid = descendant.pid; });
      }
      return;
    }
    send({ type: "response", id: msg.id, result: {} });
    if (msg.method !== "droid.add_user_message") return;
    if (running) { running.texts.push(msg.params.text); return; }
    running = { turnId: msg.id, texts: [msg.params.text] };
    setTimeout(completeTurn, turnMs);
  });
  if (mode === "hold") setInterval(() => {}, 1000);
  else lines.on("close", () => process.exit(0));
}
function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  if (target.type === "custom") {
    return "Reviewed custom target.\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

`;
  writeExecutable(path.join(binDir, "droid"), source);
  fs.writeFileSync(path.join(binDir, "droid.cjs"), source);
  if (process.platform === "win32") fs.writeFileSync(path.join(binDir, "droid.cmd"), '@echo off\r\nnode "%~dp0droid" %*\r\n');
}
export function buildEnv(binDir) {
  return { ...process.env, DROID_BINARY: path.join(binDir, "droid.cjs"), PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
}
