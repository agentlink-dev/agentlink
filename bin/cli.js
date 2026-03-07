#!/usr/bin/env node
"use strict";

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OC_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const AGENTLINK_DIR = path.join(os.homedir(), ".agentlink");
const STATE_FILE = path.join(AGENTLINK_DIR, "state.json");
const PLUGIN_NAME = "agentlink";
const NPM_PACKAGE = "@agentlinkdev/agentlink";
const AGENT_ID_RE = /^[a-z0-9][a-z0-9\-]{2,39}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function info(msg) {
  console.log(`  ${msg}`);
}

function success(msg) {
  console.log(`  [ok] ${msg}`);
}

function warn(msg) {
  console.log(`  [warn] ${msg}`);
}

function fatal(msg) {
  console.error(`  [error] ${msg}`);
  process.exit(1);
}

function readOcConfig() {
  try {
    return JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function getNestedValue(obj, keyPath) {
  const parts = keyPath.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function isPluginInstalled() {
  const cfg = readOcConfig();
  const installs = getNestedValue(cfg, "plugins.installs");
  if (installs && typeof installs === "object") {
    return PLUGIN_NAME in installs;
  }
  return false;
}

function verifyOpenclaw() {
  try {
    execSync("openclaw --version", { stdio: "pipe" });
  } catch {
    fatal(
      "openclaw CLI not found on PATH.\n" +
        "  Install it first: https://docs.openclaw.dev/getting-started",
    );
  }
}

function ocConfigSet(key, value) {
  const jsonValue = typeof value === "string" ? value : JSON.stringify(value);
  execSync(`openclaw config set ${key} '${jsonValue}'`, { stdio: "pipe" });
}

function mergeIntoArray(keyPath, entry) {
  const cfg = readOcConfig();
  const current = getNestedValue(cfg, keyPath);
  const arr = Array.isArray(current) ? current : [];
  if (arr.includes(entry)) {
    info(`${keyPath} already contains "${entry}"`);
    return;
  }
  const merged = [...arr, entry];
  ocConfigSet(keyPath, merged);

  // Verify
  const after = readOcConfig();
  const result = getNestedValue(after, keyPath);
  if (!Array.isArray(result) || !result.includes(entry)) {
    fatal(`Failed to set ${keyPath} — verification failed.`);
  }
  success(`${keyPath} updated`);
}

function removeFromArray(keyPath, entry) {
  const cfg = readOcConfig();
  const current = getNestedValue(cfg, keyPath);
  if (!Array.isArray(current) || !current.includes(entry)) {
    info(`${keyPath} does not contain "${entry}" — skipping`);
    return;
  }
  const filtered = current.filter((x) => x !== entry);
  ocConfigSet(keyPath, filtered);

  // Verify
  const after = readOcConfig();
  const result = getNestedValue(after, keyPath);
  if (Array.isArray(result) && result.includes(entry)) {
    fatal(`Failed to remove "${entry}" from ${keyPath} — verification failed.`);
  }
  success(`Removed "${entry}" from ${keyPath}`);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeState(data) {
  fs.mkdirSync(AGENTLINK_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

function generateAgentId() {
  const hostname = os.hostname().toLowerCase().replace(/[^a-z0-9]/g, "");
  const ts = Date.now().toString(36);
  let id = `agent-${hostname}-${ts}`;
  // Truncate to 40 chars max
  if (id.length > 40) {
    id = id.substring(0, 40);
  }
  // Ensure trailing char is not a dash
  id = id.replace(/-+$/, "");
  // Validate
  if (!AGENT_ID_RE.test(id)) {
    // Fallback: use just agent-timestamp
    id = `agent-${ts}`;
  }
  return id;
}

function promptYesNo(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(false);
      return;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`  ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

// ---------------------------------------------------------------------------
// Setup command
// ---------------------------------------------------------------------------

async function cmdSetup(args) {
  const joinIdx = args.indexOf("--join");
  const joinCode = joinIdx !== -1 ? args[joinIdx + 1] : null;
  const localIdx = args.indexOf("--local");
  const localPath = localIdx !== -1 ? args[localIdx + 1] : null;

  if (joinIdx !== -1 && !joinCode) {
    fatal("--join requires a CODE argument");
  }
  if (localIdx !== -1 && !localPath) {
    fatal("--local requires a PATH argument");
  }

  console.log("\n  AgentLink Setup\n");

  // 1. Verify openclaw on PATH
  verifyOpenclaw();
  success("openclaw CLI found");

  // 2. Check if already installed
  if (isPluginInstalled()) {
    if (!joinCode) {
      const state = readState();
      console.log("\n  AgentLink is already installed.");
      if (state.agent_id) {
        info(`Agent ID: ${state.agent_id}`);
      }
      info("Run 'agentlink uninstall' to remove.");
      console.log("");
      return;
    }
    info("Plugin already installed — processing --join only");
  } else {
    // 3. Install plugin
    const source = localPath || NPM_PACKAGE;
    info(`Installing plugin from ${source}...`);
    try {
      execSync(`openclaw plugins install ${source}`, { stdio: "inherit" });
    } catch {
      fatal("Plugin installation failed.");
    }
    success("Plugin installed");

    // 4. Set plugins.allow
    mergeIntoArray("plugins.allow", PLUGIN_NAME);

    // 5. Set tools.alsoAllow
    const cfg = readOcConfig();
    const toolsAllow = getNestedValue(cfg, "tools.allow");
    if (Array.isArray(toolsAllow) && toolsAllow.length > 0) {
      warn(
        "tools.allow is already set — skipping tools.alsoAllow to avoid conflict.\n" +
          "    Add agentlink tools manually to tools.allow if needed.",
      );
    } else {
      mergeIntoArray("tools.alsoAllow", PLUGIN_NAME);
    }
  }

  // 6. Generate persistent agent ID
  const state = readState();
  if (!state.agent_id) {
    state.agent_id = generateAgentId();
    writeState(state);
    success(`Agent ID generated: ${state.agent_id}`);
  } else {
    info(`Agent ID: ${state.agent_id} (existing)`);
  }

  // 7. Handle --join
  if (joinCode) {
    if (!state.pending_joins) {
      state.pending_joins = [];
    }
    if (!state.pending_joins.includes(joinCode)) {
      state.pending_joins.push(joinCode);
      writeState(state);
      success(`Queued join code: ${joinCode}`);
    } else {
      info(`Join code ${joinCode} already queued`);
    }
  }

  // 8. Print summary
  console.log("\n  --- Setup Summary ---");
  info(`Plugin:   installed`);
  info(`Agent ID: ${state.agent_id}`);
  if (joinCode) {
    info(`Join:     ${joinCode} (will process on gateway start)`);
  }
  info(`Data dir: ${AGENTLINK_DIR}`);
  console.log("");

  // 9. Prompt to restart gateway
  if (!process.stdin.isTTY) {
    info("Restart the OpenClaw gateway to activate AgentLink:");
    info("  openclaw gateway stop && openclaw gateway");
    console.log("");
    return;
  }

  const restart = await promptYesNo("Restart gateway now? (y/n)");
  if (restart) {
    info("Stopping gateway...");
    try {
      execSync("openclaw gateway stop", { stdio: "pipe" });
    } catch {
      // gateway may not be running — that's fine
    }
    info("Starting gateway...");
    const child = spawn("openclaw", ["gateway"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    success("Gateway restarted in background");
  } else {
    info("Restart manually: openclaw gateway stop && openclaw gateway");
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Uninstall command
// ---------------------------------------------------------------------------

async function cmdUninstall() {
  console.log("\n  AgentLink Uninstall\n");

  // 1. Verify openclaw on PATH
  verifyOpenclaw();

  // 2. Check if installed
  if (!isPluginInstalled()) {
    info("AgentLink is not installed. Nothing to do.");
    console.log("");
    return;
  }

  // 3. Remove from tools.alsoAllow
  removeFromArray("tools.alsoAllow", PLUGIN_NAME);

  // 4. Remove from plugins.allow
  removeFromArray("plugins.allow", PLUGIN_NAME);

  // 5. Uninstall plugin
  info("Uninstalling plugin...");
  try {
    execSync(`openclaw plugins uninstall ${PLUGIN_NAME}`, { stdio: "inherit" });
  } catch {
    warn("Plugin uninstall command failed (may already be removed).");
  }
  success("Plugin uninstalled");

  // 6. Print preservation notice
  console.log("");
  info(`Uninstalled. Identity preserved in ${AGENTLINK_DIR}`);
  info(`To wipe completely: rm -rf ${AGENTLINK_DIR}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`
  Usage: agentlink <command> [options]

  Commands:
    setup       Install and configure AgentLink for OpenClaw
    uninstall   Remove AgentLink configuration (preserves identity)

  Setup options:
    --join CODE   Join a coordination group after setup
    --local PATH  Install from a local path instead of npm
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "setup":
      await cmdSetup(args.slice(1));
      break;
    case "uninstall":
      await cmdUninstall();
      break;
    default:
      printUsage();
      if (command && command !== "--help" && command !== "-h") {
        process.exit(1);
      }
      break;
  }
}

main().catch((err) => {
  console.error("  [error]", err.message || err);
  process.exit(1);
});
