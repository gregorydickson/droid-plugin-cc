import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createTempDir, readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./process.mjs";
import { validateOutputSchema } from "./job-results.mjs";

export const DEFAULT_CONTINUE_PROMPT = "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
export const TASK_THREAD_PREFIX = "Droid Companion Task";
function invocation(env = process.env) {
  const file = env.DROID_BINARY || "droid";
  return /\.[cm]js$/.test(file) ? { command: process.execPath, prefix: [file] } : { command: file, prefix: [] };
}

export function getDroidAvailability(cwd) {
  const { command, prefix } = invocation();
  return binaryAvailable(command, [...prefix, "--version"], { cwd });
}
export function getSessionRuntimeStatus() {
  return { mode: "direct", label: "per-job process", detail: "Each job runs an isolated droid exec child; sessions resume from the stored session ID.", endpoint: null };
}
export async function getDroidAuthStatus(cwd) {
  const availability = getDroidAvailability(cwd);
  return { available: availability.available, loggedIn: null, verified: false, source: "exec", detail: "Authentication is checked on the first run. Use /login in Droid or FACTORY_API_KEY.", provider: "Factory" };
}
/** Stored turn IDs include the process birth time and group; legacy PIDs are untrusted. */
function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = runCommand("ps", ["-p", String(pid), "-o", "lstart=", "-o", "pgid="], { shell: false });
  const identity = result.stdout.trim();
  return !result.error && result.status === 0 && identity ? Buffer.from(identity).toString("base64url") : null;
}
export function interruptDroidTurn(cwd, options = {}) {
  try {
    const turnId = options?.turnId;
    const match = /^pid:(\d+):([\w-]+)$/.exec(turnId ?? "");
    if (!match || processIdentity(Number(match[1])) !== match[2]) return { attempted: false, interrupted: false, transport: "process", detail: "No verified active child." };
    const result = terminateProcessTree(Number(match[1]), { signal: "SIGKILL" });
    return { attempted: result.attempted, interrupted: result.delivered, transport: result.method };
  } catch (error) {
    return { attempted: true, interrupted: false, transport: "process", detail: error.message };
  }
}
export async function findLatestTaskThread() { return null; }
export function buildPersistentTaskThreadName(prompt) { return `${TASK_THREAD_PREFIX}: ${String(prompt).slice(0, 56)}`; }
export async function importExternalAgentSession() {
  throw new Error("Native Claude transcript import is unavailable in Droid. Start /droid:rescue with a summary or pass --brief/--preread to a worker.");
}
export function readOutputSchema(file) { return readJsonFile(file); }
export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) return { parsed: null, parseError: fallback.failureMessage ?? "Droid did not return a final structured message.", rawOutput: rawOutput ?? "", ...fallback };
  try { return { parsed: JSON.parse(rawOutput), parseError: null, rawOutput, ...fallback }; }
  catch (error) { return { parsed: null, parseError: error.message, rawOutput, ...fallback }; }
}
export function isQuotaError(error) {
  return ["quota_exhausted", "insufficient_quota"].includes(error?.code) || /\b(insufficient_quota|quota exhausted|usage limit exceeded)\b/i.test(error?.message ?? "");
}
export function createQuotaError(source) {
  return Object.assign(new Error(source?.message ?? "Droid quota exhausted."), {
    code: "quota_exhausted", error: "quota_exhausted", exitCode: 75,
    retryAfter: source?.retryAfter ?? source?.data?.retryAfter ?? null
  });
}

/** One child per turn. stdout is newline-delimited Factory JSON-RPC, never prose. */
export async function runDroidTurn(cwd, options = {}) {
  let prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) throw new Error("A prompt is required for this Droid run.");
  const schema = options.pauseAndAsk && options.outputSchema != null ? buildPauseOutputSchema(options.outputSchema) : options.outputSchema;
  const validate = schema != null ? validateOutputSchema(schema) : null;
  if (schema != null) prompt += `\n\nReturn only JSON matching this JSON schema (no Markdown fences):\n${JSON.stringify(schema)}`;
  if (options.pauseAndAsk && schema != null) prompt += '\nUse state "completed" with result populated, null question/draftAnswer and empty facts/itemsHeld; or state "awaiting-answer" with result null and a specific question, draftAnswer, facts and itemsHeld.';
  if (options.developerInstructions) prompt = `${options.developerInstructions}\n\n${prompt}`;
  let result = await executeTurn(cwd, { ...options, prompt });
  if (validate && result.status === 0) {
    let valid;
    try { valid = validate(JSON.parse(result.finalMessage)); } catch { valid = false; }
    if (!valid) {
      const firstUsage = result.usage;
      result = await executeTurn(cwd, { ...options, resumeThreadId: result.threadId,
        prompt: `Your previous answer did not match the required JSON schema. Return corrected JSON only, without tools or further task work.\nSchema: ${JSON.stringify(schema)}\nValidation errors: ${JSON.stringify(validate.errors)}\nPrevious answer: ${result.finalMessage}`, repair: true });
      if (firstUsage) result.usage = Object.fromEntries([...new Set([...Object.keys(firstUsage), ...Object.keys(result.usage ?? {})])].map(key => [key, (firstUsage[key] ?? 0) + (result.usage?.[key] ?? 0)]));
    }
    try {
      if (!validate(JSON.parse(result.finalMessage))) throw new Error(JSON.stringify(validate.errors));
    } catch (error) {
      result.status = 1;
      result.error ??= { message: `Droid output failed schema validation after one repair: ${error.message}` };
    }
  }
  if (options.pauseAndAsk && schema != null && result.status === 0) result.finalMessage = unwrapPauseOutput(result.finalMessage).rawOutput;
  return result;
}

function executeTurn(cwd, options) {
  return new Promise((resolve, reject) => {
    const dir = createTempDir("droid-prompt-");
    const file = path.join(dir, "prompt.txt");
    fs.writeFileSync(file, options.prompt, { mode: 0o600 });
    const args = ["exec", "--output-format", "stream-jsonrpc", "--cwd", cwd, "-f", file];
    const write = options.sandbox === "workspace-write" && !options.repair;
    if (write) args.push("--auto", "medium");
    else args.push("--only-tools", "Read,LS,Grep,Glob,Execute");
    if (options.model) args.push("-m", options.model);
    if (options.effort) args.push("-r", options.effort);
    if (options.resumeThreadId) args.push("--session-id", options.resumeThreadId);
    const { command, prefix } = invocation(options.env ?? process.env);
    const child = spawn(command, [...prefix, ...args], { cwd, env: options.env ?? process.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" });
    const messages = new Map();
    let threadId = null, completed = false, error = null, usage = null, stderr = "";
    const turnId = `pid:${child.pid}:${processIdentity(child.pid) ?? "unverified"}`;
    const warnings = [];
    const emitted = new Set();
    let terminalReason = null;
    const warn = message => { warnings.push({ message }); process.stderr.write(`${message}\n`); };
    const progress = (message, extra = {}) => {
      try {
        const pending = options.onProgress?.({ message, phase: "running", threadId, turnId, ...extra });
        pending?.catch?.(err => warn(`Droid progress callback failed: ${err.message}`));
      } catch (err) { warn(`Droid progress callback failed: ${err.message}`); }
    };
    const emitMessage = id => {
      if (emitted.has(id) || !messages.has(id)) return;
      const text = [...messages.get(id).entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join("");
      emitted.add(id);
      progress(text, { logTitle: "Droid output", logBody: text });
    };
    const stop = () => { try { terminateProcessTree(child.pid, { signal: "SIGKILL" }); } catch {} };
    const onSignal = () => stop();
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    const timeout = options.timeoutMs == null ? null : setTimeout(() => { error = { message: "Droid run timed out." }; stop(); }, options.timeoutMs);
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-65536); });
    child.on("error", err => { error = { message: err.message }; });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.jsonrpc !== "2.0") throw new Error("Expected Factory JSON-RPC output.");
        if (event.error) warnings.push(event.error);
        if (event.result?.sessionId) { threadId = event.result.sessionId; progress(`Session ready (${threadId}).`, { phase: "starting" }); }
        if (event.method !== "droid.session_notification") return;
        if (event.params?.sessionId && threadId && event.params.sessionId !== threadId) return;
        const n = event.params?.notification;
        if (!n) return;
        if (n.type === "error") warnings.push(n);
        if (n.type === "assistant_text_delta") {
          const blocks = messages.get(n.messageId) ?? new Map();
          blocks.set(n.blockIndex, (blocks.get(n.blockIndex) ?? "") + n.textDelta);
          messages.set(n.messageId, blocks);
        }
        if (n.type === "create_message" && n.message?.role === "assistant") {
          const blocks = new Map((n.message.content ?? []).flatMap((block, index) => block.type === "text" ? [[index, block.text]] : []));
          if (blocks.size) messages.set(n.message.id, blocks);
        }
        if (n.type === "assistant_text_complete") emitMessage(n.messageId);
        if (n.type === "assistant_message_retracted") messages.delete(n.messageId);
        if (n.type === "tool_call") {
          for (const id of messages.keys()) emitMessage(id);
          progress(`Running tool: ${n.toolUse?.name ?? "tool"}`);
        }
        if (n.type === "agent_turn_completed") {
          completed = true; terminalReason = n.reason; usage = n.tokenUsage ?? null;
          for (const id of messages.keys()) emitMessage(id);
          if (n.reason !== "completed") error ??= warnings.at(-1) ?? { message: `Droid turn ended: ${n.reason}` };
        }
      } catch (err) {
        if (completed) warn(`Droid stdout after completion: ${line}`);
        else { error = { message: `Invalid Droid protocol: ${err.message}` }; stop(); }
      }
    });
    child.on("exit", stop);
    child.on("close", code => {
      clearTimeout(timeout); process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
      fs.rmSync(dir, { recursive: true, force: true });
      const last = [...messages.values()].at(-1);
      const finalMessage = last ? [...last.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join("") : "";
      if (!completed || code !== 0) error ??= warnings.at(-1);
      if (!finalMessage.trim()) error ??= { message: stderr.trim() || "Droid returned no final assistant message." };
      if (!completed) error ??= { message: stderr.trim() || "Droid exited without a turn completion event." };
      if (!threadId) error ??= { message: "Droid returned no session ID." };
      if (isQuotaError(error)) { reject(createQuotaError(error)); return; }
      resolve({ status: code === 0 && terminalReason === "completed" && !error ? 0 : 1, threadId, turnId, finalMessage, usage,
        error, warnings, stderr, reasoningSummary: [], touchedFiles: [], fileChanges: [], commandExecutions: [], children: [] });
    });
    try {
      // Persist the child group before initialization, so early cancellation works.
      progress("Starting Droid child.");
      options.onActiveTurn?.({ threadId, turnId, send: async () => { throw new Error("Live steering is unavailable for one-shot Droid jobs. Cancel or resume with another prompt."); } });
    } catch (err) { error = { message: err.message }; stop(); }
  });
}
export function buildPauseOutputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("--pause-and-ask with --output-schema requires an object schema.");
  const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
  const schemaChildren = new Set(["additionalProperties", "unevaluatedProperties", "contains", "not", "if", "then", "else", "propertyNames", "contentSchema", "additionalItems", "unevaluatedItems", "items"]);
  const schemaLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  function relocate(value) {
    if (Array.isArray(value)) return value.map(relocate);
    if (!value || typeof value !== "object") return value;
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      if (["$id", "$anchor", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"].includes(key)) {
        throw new Error(`--pause-and-ask cannot safely wrap a schema using ${key}; use a self-contained schema with local JSON-pointer references.`);
      }
      if (key === "$ref") {
        if (typeof entry !== "string" || (entry !== "#" && !entry.startsWith("#/"))) throw new Error("--pause-and-ask schemas must use local JSON-pointer references, not external or anchor references.");
        copy[key] = `#/properties/result/anyOf/0${entry.slice(1)}`;
      } else if (schemaMaps.has(key) && entry && typeof entry === "object") {
        copy[key] = Object.fromEntries(Object.entries(entry).map(([name, child]) => [name, relocate(child)]));
      } else if (schemaChildren.has(key) || schemaLists.has(key)) copy[key] = relocate(entry);
      else if (key !== "$schema") copy[key] = entry;
    }
    return copy;
  }
  return {
    type: "object", additionalProperties: false,
    required: ["state", "result", "question", "draftAnswer", "facts", "itemsHeld"],
    properties: {
      state: { type: "string", enum: ["completed", "awaiting-answer"] },
      result: { anyOf: [relocate(schema), { type: "null" }] },
      question: { type: ["string", "null"] }, draftAnswer: { type: ["string", "null"] },
      facts: { type: "array", items: { type: "string" } }, itemsHeld: { type: "array", items: { type: "string" } }
    }
  };
}

function unwrapPauseOutput(rawOutput) {
  let value;
  try { value = JSON.parse(rawOutput); } catch { throw new Error("Droid returned an invalid pause-and-ask transport object."); }
  if (!value || !["completed", "awaiting-answer"].includes(value.state) || !("result" in value)) throw new Error("Droid returned an invalid pause-and-ask transport object.");
  if (value.state === "completed") return { rawOutput: JSON.stringify(value.result), awaitingAnswer: false };
  if (typeof value.question !== "string" || !value.question.trim() || !Array.isArray(value.facts) || !Array.isArray(value.itemsHeld)) throw new Error("Droid returned an incomplete stop report.");
  const { result, ...report } = value;
  return { rawOutput: JSON.stringify(report), awaitingAnswer: true };
}
