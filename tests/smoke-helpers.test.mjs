import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { smokeEnv } from "./helpers.mjs";

const AUTH_NAMES = ["auth.v2.file", "auth.v2.key", "auth.v2.loginkeychain"];
const realFactory = path.join(os.homedir(), ".factory");
const realAuth = AUTH_NAMES.filter(name => fs.existsSync(path.join(realFactory, name)));

test("smokeEnv gives each call a fresh plugin data dir and no Factory home override", () => {
  const saved = process.env.FACTORY_HOME_OVERRIDE;
  delete process.env.FACTORY_HOME_OVERRIDE;
  try {
    const a = smokeEnv();
    const b = smokeEnv();
    assert.notEqual(a.CLAUDE_PLUGIN_DATA, b.CLAUDE_PLUGIN_DATA);
    assert.ok(fs.statSync(a.CLAUDE_PLUGIN_DATA).isDirectory());
    assert.equal("FACTORY_HOME_OVERRIDE" in a, false);
  } finally {
    if (saved !== undefined) process.env.FACTORY_HOME_OVERRIDE = saved;
  }
});

test("smokeEnv({ fenced }) builds a login-only Factory home with an empty mcp.json", { skip: realAuth.length === 0 && "no Factory login on this machine" }, () => {
  const env = smokeEnv({ fenced: true });
  const factoryDir = path.join(env.FACTORY_HOME_OVERRIDE, ".factory");
  assert.equal(fs.existsSync(path.join(factoryDir, "settings.json")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(factoryDir, "mcp.json"), "utf8")), { mcpServers: {} });
  const linked = fs.readdirSync(factoryDir).filter(name => name !== "mcp.json");
  assert.deepEqual(new Set(linked), new Set(realAuth));
  for (const name of linked) {
    assert.ok(fs.lstatSync(path.join(factoryDir, name)).isSymbolicLink());
    assert.equal(fs.realpathSync(path.join(factoryDir, name)), fs.realpathSync(path.join(realFactory, name)));
  }
  assert.notEqual(env.CLAUDE_PLUGIN_DATA, smokeEnv({ fenced: true }).CLAUDE_PLUGIN_DATA);
});

test("smokeEnv({ fenced }) throws when no Factory login exists", () => {
  const savedHome = process.env.HOME;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "droid-nologin-"));
  process.env.HOME = empty;
  try {
    assert.throws(() => smokeEnv({ fenced: true }), /no Factory login found under ~\/\.factory/);
  } finally {
    process.env.HOME = savedHome;
  }
});
