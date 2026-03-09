#!/usr/bin/env node

/**
 * AgentLink CLI
 *
 * npx @agentlinkdev/agentlink setup          — Install plugin + generate identity
 * npx @agentlinkdev/agentlink setup --join CODE — Install + join via invite code
 * npx @agentlinkdev/agentlink uninstall       — Remove plugin (preserves identity)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const DATA_DIR = path.join(os.homedir(), ".agentlink");
const IDENTITY_FILE = path.join(DATA_DIR, "identity.json");

const ID_CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateSuffix(len = 4) {
  return Array.from({ length: len }, () =>
    ID_CHARSET[Math.floor(Math.random() * ID_CHARSET.length)]
  ).join("");
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "agent";
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function setup(joinCode) {
  console.log("\n  AgentLink Setup\n");

  // Step 1: Check for openclaw CLI
  try {
    execSync("which openclaw", { stdio: "pipe" });
  } catch {
    console.error("  Error: 'openclaw' CLI not found on PATH.");
    console.error("  Install OpenClaw first: https://github.com/openclaw/openclaw");
    process.exit(1);
  }

  // Step 2: Install plugin
  console.log("  Installing AgentLink plugin...");
  try {
    execSync("openclaw plugins install @agentlinkdev/agentlink", { stdio: "inherit" });
  } catch {
    console.error("  Warning: Plugin install may have failed. Continuing with setup...");
  }

  // Step 3: Generate or load identity
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let identity;
  if (fs.existsSync(IDENTITY_FILE)) {
    try {
      identity = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf-8"));
      console.log(`\n  Existing identity found: ${identity.agent_id} (${identity.human_name})`);
    } catch {
      identity = null;
    }
  }

  if (!identity) {
    const name = await ask("  What's your name? ");
    if (!name) {
      console.error("  Name is required.");
      process.exit(1);
    }
    const agentId = `${slugify(name)}-${generateSuffix()}`;
    identity = { agent_id: agentId, human_name: name };
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2) + "\n");
    console.log(`\n  Your agent ID: ${agentId}`);
  }

  // Step 4: Enable plugin in openclaw.json
  console.log("  Enabling AgentLink in openclaw config...");
  try {
    execSync(
      `openclaw config set plugins.allow '["agentlink"]' && openclaw config set tools.alsoAllow '["agentlink"]'`,
      { stdio: "pipe" }
    );
  } catch {
    console.log("  Note: Could not auto-configure. Add 'agentlink' to plugins.allow and tools.alsoAllow manually.");
  }

  // Step 5: Store join code for processing on next gateway start
  if (joinCode) {
    const pendingFile = path.join(DATA_DIR, "pending_join.json");
    fs.writeFileSync(pendingFile, JSON.stringify({ code: joinCode }) + "\n");
    console.log(`\n  Invite code ${joinCode} will be processed on next gateway start.`);
  }

  console.log("\n  Setup complete!");
  console.log(`  Agent ID: ${identity.agent_id}`);
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log("\n  Restart your gateway to activate AgentLink:");
  console.log("    openclaw gateway stop && openclaw gateway\n");
}

function uninstall() {
  console.log("\n  Uninstalling AgentLink plugin...");
  try {
    execSync("openclaw plugins uninstall @agentlinkdev/agentlink", { stdio: "inherit" });
  } catch {
    console.log("  Plugin may already be uninstalled.");
  }
  console.log(`\n  Plugin removed. Identity preserved in ${DATA_DIR}`);
  console.log("  To fully remove: rm -rf ~/.agentlink\n");
}

// --- Main ---
const args = process.argv.slice(2);
const command = args[0];

if (command === "setup") {
  const joinIdx = args.indexOf("--join");
  const joinCode = joinIdx >= 0 ? args[joinIdx + 1] : undefined;
  setup(joinCode);
} else if (command === "uninstall") {
  uninstall();
} else {
  console.log("\n  AgentLink CLI\n");
  console.log("  Usage:");
  console.log("    npx @agentlinkdev/agentlink setup              Install + generate identity");
  console.log("    npx @agentlinkdev/agentlink setup --join CODE  Install + join via invite");
  console.log("    npx @agentlinkdev/agentlink uninstall          Remove plugin\n");
}
