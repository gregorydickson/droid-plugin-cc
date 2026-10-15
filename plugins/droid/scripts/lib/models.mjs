/** Every level some Factory model accepts; the CLI owns which levels each model supports. */
export const VALID_REASONING_EFFORTS = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Pass Factory model IDs through; the CLI owns model availability. */
export function normalizeRequestedModel(model) {
  return model == null ? null : String(model).trim() || null;
}

export function normalizeReasoningEffort(effort) {
  const normalized = effort == null ? "" : String(effort).trim().toLowerCase();
  if (!normalized) return null;
  if (!VALID_REASONING_EFFORTS.includes(normalized)) throw new Error(`Unsupported reasoning effort "${effort}". Use one of: ${VALID_REASONING_EFFORTS.join(", ")}.`);
  return normalized;
}

/** Explicit flags win, then DROID_DEFAULT_MODEL / DROID_DEFAULT_EFFORT, then the CLI's own defaults. */
export function resolveModelChoice(options = {}, env = process.env) {
  return {
    model: normalizeRequestedModel(options.model) ?? normalizeRequestedModel(env.DROID_DEFAULT_MODEL),
    effort: normalizeReasoningEffort(options.effort) ?? normalizeReasoningEffort(env.DROID_DEFAULT_EFFORT)
  };
}

function helpSection(lines, title) {
  const start = lines.findIndex(line => line.trim() === `${title}:` && !/^\s/.test(line));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.trim() && !/^\s/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter(line => line.trim());
}

/** Parse `droid exec --help`: "Available Models:" rows are `id  Name`, "Model details:" rows are keyed by Name. */
export function parseDroidModels(helpText) {
  const lines = String(helpText ?? "").split(/\r?\n/);
  const available = helpSection(lines, "Available Models");
  if (!available) throw new Error("droid exec --help has no \"Available Models:\" section; this droid version lists models differently.");
  const details = new Map((helpSection(lines, "Model details") ?? []).flatMap(line => {
    const match = /^\s*-\s+(.+?):\s+supports reasoning:\s*(yes|no)\s*;\s*supported:\s*\[([^\]]*)\]\s*;\s*default:\s*(\S+)\s*$/i.exec(line);
    if (!match) return [];
    const supportsReasoning = match[2].toLowerCase() === "yes";
    const efforts = supportsReasoning ? match[3].split(",").map(level => level.trim().toLowerCase()).filter(Boolean) : [];
    return [[match[1].trim(), { supportsReasoning, efforts, defaultEffort: supportsReasoning ? match[4].toLowerCase() : null }]];
  }));
  const listed = available.flatMap(line => {
    const match = /^\s+(\S+)\s{2,}(\S.*?)\s*$/.exec(line);
    if (!match) return [];
    const marked = /\s*\(default\)$/.test(match[2]);
    const name = match[2].replace(/\s*\(default\)$/, "");
    const detail = details.get(name) ?? { supportsReasoning: null, efforts: null, defaultEffort: null };
    return [{ id: match[1], name, deprecated: /\[deprecated\]/i.test(name), ...detail, marked }];
  });
  if (!listed.length) throw new Error("droid exec --help listed no models under \"Available Models:\".");
  const defaultModel = /--model <id>.*\(default:\s*([^)\s]+)\)/.exec(helpText)?.[1] ?? listed.find(model => model.marked)?.id ?? null;
  return { defaultModel, models: listed.map(({ marked, ...model }) => ({ ...model, isDefault: model.id === defaultModel })) };
}

export function renderModelsTable({ defaultModel, models }, defaults = {}) {
  const cell = value => String(value ?? "").replace(/\|/g, "\\|");
  const lines = ["# Droid Models", "", `CLI default model: ${defaultModel ?? "unknown"}`];
  if (defaults.model || defaults.effort) lines.push(`Plugin defaults: model ${defaults.model ?? "(CLI default)"}, effort ${defaults.effort ?? "(model default)"}`);
  lines.push("", "| Model ID | Name | Reasoning efforts | Default effort |", "| --- | --- | --- | --- |");
  for (const model of models) {
    const efforts = model.efforts == null ? "unknown" : model.supportsReasoning ? model.efforts.join(", ") : "not supported";
    lines.push(`| ${cell(model.id)}${model.isDefault ? " (default)" : ""} | ${cell(model.name)} | ${cell(efforts)} | ${cell(model.defaultEffort ?? "")} |`);
  }
  return `${lines.join("\n")}\n`;
}
