import test from "node:test";
import assert from "node:assert/strict";

import { formatUsage, renderJobStatusReport, renderReviewResult, renderStatusReport, renderStoredJobResult } from "../plugins/droid/scripts/lib/render.mjs";
import { streamJsonUsage } from "../plugins/droid/scripts/lib/droid.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Droid returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Droid Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Droid Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Droid Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Droid session ID: thr_123/);
  assert.match(output, /Resume in Droid: droid resume thr_123/);
});

const usage = { inputTokens: 9, outputTokens: 402, cacheCreationTokens: 5345, cacheReadTokens: 0, thinkingTokens: 390, factoryCredits: 3481 };
const statusReport = jobs => ({ sessionRuntime: { label: "per-job process" }, config: {}, running: [], latestFinished: jobs[0] ?? null, recent: jobs.slice(1), needsReview: false });

test("formatUsage renders tokens and credits, and nothing for absent usage", () => {
  assert.equal(formatUsage(usage), "9 in / 402 out tokens, 3481 credits");
  assert.equal(formatUsage({ inputTokens: 10, outputTokens: 2 }), "10 in / 2 out tokens");
  assert.equal(formatUsage({ factoryCredits: 0 }), "0 credits");
  for (const empty of [null, undefined, {}, { factoryCredits: "12" }]) assert.equal(formatUsage(empty), null);
});

test("stream-json usage keeps Factory credits under the JSON-RPC key", () => {
  assert.deepEqual(streamJsonUsage({ input_tokens: 9, output_tokens: 402, cache_read_input_tokens: 0, cache_creation_input_tokens: 5345, thinking_tokens: 390, factory_credits: 3481, ttft_ms: 812 }), usage);
  assert.deepEqual(streamJsonUsage({ input_tokens: 1, factoryCredits: 5 }), { inputTokens: 1, factoryCredits: 5 });
  assert.deepEqual(streamJsonUsage({ input_tokens: 1, factory_credits: "5" }), { inputTokens: 1 });
  assert.equal(streamJsonUsage(null), null);
});

test("status renders per-job usage and totals credits only over jobs that reported them", () => {
  const jobs = [
    { id: "task-a", status: "completed", usage },
    { id: "task-b", status: "completed", usage: { inputTokens: 1, outputTokens: 1, factoryCredits: 19 } },
    { id: "task-c", status: "failed", usage: null },
    { id: "task-e", status: "completed", usage: { inputTokens: 3, outputTokens: 4 } }
  ];
  const credited = jobs.filter(job => job.usage?.factoryCredits != null);
  const output = renderStatusReport(statusReport(jobs));
  assert.match(output, /- task-a \| completed\n {2}Usage: 9 in \/ 402 out tokens, 3481 credits/);
  assert.match(output, /- task-b \| completed\n {2}Usage: 1 in \/ 1 out tokens, 19 credits/);
  assert.doesNotMatch(output, /- task-c \| failed\n {2}Usage/);
  assert.match(output, /- task-e \| completed\n {2}Usage: 3 in \/ 4 out tokens\n/);
  assert.match(output, new RegExp(`Total credits: ${credited.reduce((sum, job) => sum + job.usage.factoryCredits, 0)} across ${credited.length} listed jobs with usage`));
});

test("status without usage renders no usage or total lines", () => {
  const output = renderStatusReport(statusReport([{ id: "task-c", status: "completed", usage: null }, { id: "task-d", status: "completed" }]));
  assert.doesNotMatch(output, /Usage:|Total credits/);
  assert.doesNotMatch(renderJobStatusReport({ id: "task-d", status: "completed" }), /Usage:/);
  assert.match(renderJobStatusReport({ id: "task-a", status: "completed", usage }), /Usage: 9 in \/ 402 out tokens, 3481 credits/);
});

test("result appends a usage line from the stored job, and none when usage is null", () => {
  const job = { id: "task-a", status: "completed", title: "Droid Task" };
  const withUsage = renderStoredJobResult(job, { threadId: "thr_1", usage, result: { rawOutput: "Done." } });
  assert.match(withUsage, /^Done\.\n/);
  assert.match(withUsage, /Resume in Droid: droid resume thr_1\n\nUsage: 9 in \/ 402 out tokens, 3481 credits\n$/);
  assert.match(renderStoredJobResult(job, { result: { rawOutput: "Done.", usage: { factoryCredits: 4 } } }), /Usage: 4 credits\n$/);
  assert.doesNotMatch(renderStoredJobResult(job, { usage: null, result: { rawOutput: "Done.", usage: null } }), /Usage:/);
  assert.doesNotMatch(renderStoredJobResult(job, null), /Usage:/);
});
