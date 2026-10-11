import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { writeExecutable } from "./helpers.mjs";

export function installFakeDroid(binDir, behavior = "review-ok", worker = false) {
  const statePath = path.join(binDir, "fake-droid-state.json");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};
const WORKER = ${JSON.stringify(worker)};
const args = process.argv.slice(2);
const arg = flag => args[args.indexOf(flag) + 1];
if (args[0] === "--version") { console.log("droid-cli test"); process.exit(0); }
if (args[0] !== "exec" || arg("--output-format") !== "stream-jsonrpc") process.exit(2);
const prompt = fs.readFileSync(arg("-f"), "utf8");
const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH)) : { threads: [], threadRequests: [], execStarts: 0 };
state.execStarts++;
const resume = args.includes("--session-id");
const threadId = resume ? arg("--session-id") : crypto.randomUUID();
if (!resume) state.threads.push({ id: threadId, cwd: process.cwd() });
const turnId = crypto.randomUUID();
state.lastTurnStart = { threadId, turnId, prompt, model: args.includes("-m") ? arg("-m") : null, effort: args.includes("-r") ? arg("-r") : null };
state.turns = [...(state.turns || []), state.lastTurnStart];
state.threadRequests.push({ method: resume ? "resume" : "start", threadId, cwd: process.cwd(), args });
fs.writeFileSync(STATE_PATH, JSON.stringify(state));
const envelope = { jsonrpc: "2.0", factoryApiVersion: "1.0.0", factoryProtocolVersion: "1.257.0" };
const send = msg => process.stdout.write(JSON.stringify({ ...envelope, ...msg }) + "\\n");
const notify = notification => send({ type: "notification", method: "droid.session_notification", params: { sessionId: threadId, notification } });
send({ type: "response", id: "init", result: { sessionId: threadId } });
if (BEHAVIOR === "auth-run-fails") { notify({ type: "error", message: "Authentication failed: sign in to Droid" }); process.exit(1); }
if (BEHAVIOR === "stubborn-task") {
  const child = require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  state.rootPid = process.pid; state.descendantPid = child.pid;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);
}
else if (BEHAVIOR === "malformed") { console.log("not JSON"); setTimeout(() => {}, 10000); }
else if (BEHAVIOR === "no-completion") process.exit(0);
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
const finish = () => {
  if (BEHAVIOR === "warning-success") notify({ type: "error", message: "Temporary model error" });
  if (BEHAVIOR === "blank-lines") console.log("  ");
  notify({ type: "assistant_text_delta", messageId: "answer", blockIndex: 0, textDelta: payload.slice(0, 7) });
  notify({ type: "assistant_text_delta", messageId: "answer", blockIndex: 0, textDelta: payload.slice(7) });
  notify({ type: "assistant_text_complete", messageId: "answer", blockIndex: 0 });
  if (BEHAVIOR === "text-then-hang") return;
  notify({ type: "agent_turn_completed", reason: "completed", turnId, tokenUsage: { inputTokens: 10, outputTokens: 2 } });
  if (BEHAVIOR === "trailing-prose") console.log("late diagnostic");
};
if (BEHAVIOR === "interruptible-slow-task") setTimeout(finish, 5000);
else if (BEHAVIOR === "slow-task") setTimeout(finish, 400);
else finish();
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
