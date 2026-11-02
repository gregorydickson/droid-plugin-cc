import "./isolate-env.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
export function makeTempDir(prefix = "droid-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source.replace("#!/usr/bin/env node", `#!${process.execPath}`), { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command === "node" ? process.execPath : command, args, {
    timeout: options.timeout ?? 15000,
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Droid Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

export const SMOKE_MODEL = process.env.DROID_SMOKE_MODEL ?? "glm-5.3";

const FACTORY_AUTH_FILES = ["auth.v2.file", "auth.v2.key", "auth.v2.loginkeychain"];

// Live-smoke env. `fenced` gives droid a Factory home with only the real login
// (symlinked) and an empty mcp.json, so it starts no MCP server and reads no
// settings.json default model.
export function smokeEnv({ fenced = false } = {}) {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: makeTempDir("droid-smoke-data-") };
  if (!fenced) return env;
  const realFactory = path.join(os.homedir(), ".factory");
  const links = FACTORY_AUTH_FILES.filter(name => fs.existsSync(path.join(realFactory, name)));
  if (links.length === 0) throw new Error("no Factory login found under ~/.factory");
  const home = makeTempDir("droid-smoke-home-");
  const factoryDir = path.join(home, ".factory");
  fs.mkdirSync(factoryDir, { recursive: true });
  for (const name of links) fs.symlinkSync(path.join(realFactory, name), path.join(factoryDir, name));
  fs.writeFileSync(path.join(factoryDir, "mcp.json"), '{"mcpServers":{}}\n');
  env.FACTORY_HOME_OVERRIDE = home;
  return env;
}
