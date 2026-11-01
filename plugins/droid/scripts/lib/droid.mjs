import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createTempDir, readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./process.mjs";
import { validateOutputSchema } from "./job-results.mjs";
import { normalizeReasoningEffort } from "./models.mjs";

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

export const DROID_FEATURE_FLOOR = "1.1.0";
export const JOB_KINDS = Object.freeze(["task", "review", "adversarial-review", "mission"]);
export const TAG_NAME = "droid-plugin-cc";
const CAPABILITY_NAMES = ["tag", "systemPromptFile", "mission", "fork", "spec", "steer"];
const versionCache = new Map();

function parseSemver(text) {
  const match = /\d+\.\d+\.\d+/.exec(text ?? "");
  return match ? match[0] : null;
}
function compareSemver(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

/** Runs `<binary> --version` once per process per binary path. */
export function getDroidVersion(env = process.env) {
  const { command, prefix } = invocation(env);
  const key = [command, ...prefix, env.PATH ?? ""].join("\0");
  if (!versionCache.has(key)) {
    const result = runCommand(command, [...prefix, "--version"], { env });
    const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    versionCache.set(key, { version: parseSemver(raw), raw });
  }
  return versionCache.get(key);
}

/** Unparseable output counts as capable: every key true. */
export function droidCapabilities(version) {
  const found = parseSemver(version);
  const capable = found === null || compareSemver(found, DROID_FEATURE_FLOOR) >= 0;
  return Object.freeze(Object.fromEntries(CAPABILITY_NAMES.map(name => [name, capable])));
}

export function requireDroidCapability(name, version) {
  const caps = droidCapabilities(version);
  if (!CAPABILITY_NAMES.includes(name)) throw new Error(`Unknown Droid capability: ${name}`);
  if (!caps[name]) throw new Error(`requires Droid CLI >= ${DROID_FEATURE_FLOOR} (found ${version})`);
}

export function getDroidExecHelp(cwd) {
  const { command, prefix } = invocation();
  return runCommand(command, [...prefix, "exec", "--help"], { cwd });
}
export function getSessionRuntimeStatus() {
  return { mode: "direct", label: "per-job process", detail: "Each job runs an isolated droid exec child; sessions resume from the stored session ID.", endpoint: null };
}
export const DROID_DOCTOR_CHECKS = "config,auth,connectivity";
const DOCTOR_TIMEOUT_DEFAULT_MS = 15000;

function doctorTimeoutMs(env) {
  const parsed = Number(env.DROID_DOCTOR_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DOCTOR_TIMEOUT_DEFAULT_MS;
}

/** Runs `droid doctor --json` in its own process group so a hung connectivity check dies with its children. */
function runDoctor(cwd, env = process.env) {
  const { command, prefix } = invocation(env);
  const timeoutMs = doctorTimeoutMs(env);
  return new Promise(resolve => {
    let stdout = "";
    let timer = null;
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const child = spawn(command, [...prefix, "doctor", "--json", "--checks", DROID_DOCTOR_CHECKS], { cwd, env, stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true });
    timer = setTimeout(() => {
      try { terminateProcessTree(child.pid, { signal: "SIGKILL" }); } catch { /* already gone */ }
      finish({ reason: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.on("error", error => finish({ reason: error.message }));
    child.on("close", (status, signal) => finish(status === 0 ? { stdout } : { reason: `exit ${status ?? signal}` }));
  });
}

function parseDoctor(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed?.results) ? parsed.results : null;
  } catch { return null; }
}

/** Reports the host's Droid login and health. Doctor failure never throws: the shape degrades with a `doctor` warning. */
export async function getDroidAuthStatus(cwd, env = process.env) {
  const availability = getDroidAvailability(cwd);
  const degraded = reason => ({
    available: availability.available, loggedIn: null, verified: false, source: "exec", label: "first run",
    detail: "Authentication is checked on the first run. Use /login in Droid or FACTORY_API_KEY.", provider: "Factory",
    warnings: availability.available ? [{ id: "doctor", status: "warn", detail: `droid doctor unavailable: ${reason}`, remediation: null }] : []
  });
  if (!availability.available) return degraded("droid not found");
  const outcome = await runDoctor(cwd, env);
  if (outcome.reason) return degraded(outcome.reason);
  const results = parseDoctor(outcome.stdout);
  if (!results) return degraded("invalid JSON");
  const authResults = results.filter(result => String(result?.id).startsWith("auth."));
  const verified = authResults.length > 0;
  const loggedIn = verified ? authResults.every(result => result.status === "pass") : null;
  const warnings = results.filter(result => result?.status === "warn" || result?.status === "fail")
    .map(({ id, status, detail, remediation }) => ({ id, status, detail, remediation: remediation ?? null }));
  const summary = !verified ? "no auth check reported" : loggedIn ? "logged in" : "not logged in";
  return {
    available: true, loggedIn, verified, warnings, source: "doctor", label: "host Droid health", provider: "Factory",
    detail: `host Droid health: ${summary} (droid doctor, ${warnings.length === 0 ? "no warnings" : "see warnings"}). A lane runs against its own home, so this describes the host.`
  };
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
  const instructions = options.developerInstructions;
  const instructionsInSystemPrompt = Boolean(instructions) && droidCapabilities(getDroidVersion(options.env ?? process.env).version).systemPromptFile;
  if (instructions && !instructionsInSystemPrompt) prompt = `${instructions}\n\n${prompt}`;
  const turnOptions = { ...options, systemPromptText: instructionsInSystemPrompt ? instructions : undefined };
  let result = await executeTurn(cwd, { ...turnOptions, prompt });
  if (validate && result.status === 0) {
    let valid;
    try { valid = validate(JSON.parse(result.finalMessage)); } catch { valid = false; }
    if (!valid) {
      const firstUsage = result.usage;
      result = await executeTurn(cwd, { ...turnOptions, resumeThreadId: result.threadId,
        prompt: `Your previous answer did not match the required JSON schema. Return corrected JSON only, without tools or further task work.\nSchema: ${JSON.stringify(schema)}\nValidation errors: ${JSON.stringify(validate.errors)}\nPrevious answer: ${result.finalMessage}`, repair: true });
      // A continued turn reports session-inclusive usage, which already counts the first turn.
      result.usage ??= firstUsage;
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

export const WEB_TOOLS = Object.freeze(["WebSearch", "FetchUrl"]);
export const SUBAGENT_TOOLS = Object.freeze(["Task", "TaskOutput", "TaskStop"]);
export const RUN_COMMANDS_TOOLS = Object.freeze(["Read", "LS", "Grep", "Glob", "Execute"]);
export const REPAIR_TOOLS = RUN_COMMANDS_TOOLS;
export const READ_ONLY_TOOLS = Object.freeze([...RUN_COMMANDS_TOOLS, ...WEB_TOOLS, "Skill", "ToolSearch", "TodoWrite", ...SUBAGENT_TOOLS]);

/** READ_ONLY_TOOLS minus exactly the groups a job opted out of. */
function readOnlyTools({ noWeb, noSubagents }) {
  const dropped = new Set([...(noWeb ? WEB_TOOLS : []), ...(noSubagents ? SUBAGENT_TOOLS : [])]);
  return READ_ONLY_TOOLS.filter(tool => !dropped.has(tool));
}

/** `server` or `server/tool` (percent-encoded segments), optionally written with droid's `MCP:` prefix. */
export function normalizeMcpToolSelector(value) {
  const selector = String(value ?? "").replace(/^MCP:/, "");
  if (!/^[^\s,/]+(\/[^\s,/]+)?$/.test(selector)) {
    throw new Error(`Invalid --mcp-tool "${value}". Use <server> or <server>/<tool>; percent-encode a "/", "," or space inside a name.`);
  }
  return selector;
}

/**
 * droid refuses --session-id on a one-shot stream-jsonrpc exec, and a JSON-RPC
 * input session (--input-format stream-jsonrpc) ignores --auto/-m/-r/--only-tools,
 * which would drop the tool fence. So a fresh turn is a one-shot stream-jsonrpc
 * exec and a continued turn (resume, answer, schema repair) streams stream-json;
 * neither passes --input-format, so the fence flags apply to both.
 *
 * Fences: read-only is droid's default autonomy over READ_ONLY_TOOLS (the
 * wide toolbox: web, skills, subagents, minus whatever --no-web/--no-subagents
 * drop) plus any MCP selectors; run-commands is
 * --auto medium over RUN_COMMANDS_TOOLS plus MCP selectors (commands run, no
 * file tools, but the shell can still write). Run-commands stays on the narrow
 * five because the lane wrapper refuses any run-commands --only-tools member
 * outside Read, LS, Grep, Glob and Execute. A schema-repair turn is default
 * autonomy over REPAIR_TOOLS with no MCP selectors. Workspace-write is --auto
 * medium over droid's default toolset.
 */
export function buildDroidExecArgs(cwd, file, options = {}) {
  const resume = Boolean(options.resumeThreadId);
  if (options.tag && !JOB_KINDS.includes(options.tag.kind)) throw new Error(`Unknown job kind "${options.tag.kind}"`);
  const args = ["exec", "--output-format", resume ? "stream-json" : "stream-jsonrpc", "--cwd", cwd, "-f", file];
  const sandbox = options.repair ? "read-only" : options.sandbox;
  const mcpSelectors = options.repair ? [] : (options.mcpTools ?? []).map(selector => `MCP:${normalizeMcpToolSelector(selector)}`);
  if (sandbox === "workspace-write" || sandbox === "run-commands") args.push("--auto", "medium");
  if (sandbox !== "workspace-write") args.push("--only-tools", [...(options.repair ? REPAIR_TOOLS : sandbox === "run-commands" ? RUN_COMMANDS_TOOLS : readOnlyTools(options)), ...mcpSelectors].join(","));
  else if (mcpSelectors.length) args.push("--add-tools", mcpSelectors.join(","));
  if (options.model) args.push("-m", options.model);
  if (options.effort) args.push("-r", options.effort);
  if (options.spec && !options.repair) {
    args.push("--use-spec");
    if (options.specModel) args.push("--spec-model", options.specModel);
    const specEffort = normalizeReasoningEffort(options.specEffort);
    if (specEffort) args.push("--spec-reasoning-effort", specEffort);
  }
  if (resume) args.push("--session-id", options.resumeThreadId);
  if (options.systemPromptFile && !options.repair) args.push("--append-system-prompt-file", options.systemPromptFile);
  if (options.tag && !options.steerable && droidCapabilities(getDroidVersion(options.env ?? process.env).version).tag) {
    args.push("--tag", JSON.stringify({ name: TAG_NAME, metadata: { jobId: options.tag.jobId, kind: options.tag.kind } }));
  }
  return args;
}

export function streamJsonUsage(usage) {
  if (!usage) return null;
  const keys = { input_tokens: "inputTokens", output_tokens: "outputTokens", cache_read_input_tokens: "cacheReadTokens",
    cache_creation_input_tokens: "cacheCreationTokens", thinking_tokens: "thinkingTokens", factory_credits: "factoryCredits", factoryCredits: "factoryCredits" };
  return Object.fromEntries(Object.entries(keys).filter(([key]) => typeof usage[key] === "number").map(([key, name]) => [name, usage[key]]));
}

function executeTurn(cwd, options) {
  return new Promise((resolve, reject) => {
    const dir = createTempDir("droid-prompt-");
    const file = path.join(dir, "prompt.txt");
    fs.writeFileSync(file, options.prompt, { mode: 0o600 });
    let systemPromptFile;
    if (options.systemPromptText !== undefined) {
      systemPromptFile = path.join(dir, "system-prompt.txt");
      fs.writeFileSync(systemPromptFile, options.systemPromptText, { mode: 0o600 });
    }
    const args = buildDroidExecArgs(cwd, file, { ...options, systemPromptFile });
    const streamJson = args[args.indexOf("--output-format") + 1] === "stream-json";
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
        if (streamJson) {
          if (typeof event?.type !== "string") throw new Error("Expected Droid stream-json output.");
          if (event.session_id && threadId && event.session_id !== threadId) return;
          if (event.type === "system" && event.subtype === "init" && event.session_id) {
            threadId = event.session_id; progress(`Session ready (${threadId}).`, { phase: "starting" });
          }
          if (event.type === "error") warnings.push({ message: event.message ?? event.error ?? JSON.stringify(event) });
          if (event.type === "message" && event.role === "assistant" && typeof event.text === "string") {
            messages.set(event.id, new Map([[0, event.text]])); emitMessage(event.id);
          }
          if (event.type === "tool_call") progress(`Running tool: ${event.toolName ?? event.toolId ?? "tool"}`);
          if (event.type === "completion") {
            completed = true; terminalReason = "completed"; usage = streamJsonUsage(event.usage);
            if (typeof event.finalText === "string" && event.finalText.trim()) messages.set("completion", new Map([[0, event.finalText]]));
          }
          return;
        }
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
