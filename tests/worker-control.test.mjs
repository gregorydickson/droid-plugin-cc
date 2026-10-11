import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sendWorkerMessage } from "../plugins/droid/scripts/lib/worker-control.mjs";
import { makeTempDir, run } from "./helpers.mjs";

test("steering rejects immediately without creating a control queue or looking up a job", async () => {
  const cwd = makeTempDir();
  await assert.rejects(sendWorkerMessage(cwd, "unknown", "hi"), /Live steering is unavailable/);
  assert.deepEqual(fs.readdirSync(cwd), []);
  const result = run("node", [path.resolve("plugins/droid/scripts/droid-companion.mjs"), "send", "unknown", "hi"], { cwd });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Live steering is unavailable/);
});
