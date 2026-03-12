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
import pc from "picocolors";
import ora from "ora";
import { WebSocket } from "ws";
import mqtt from "mqtt";

// Respect OpenClaw environment variables (set by Railway/Docker, not by homebrew)
const OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
const OC_CONFIG_PATH = path.join(OPENCLAW_STATE_DIR, "openclaw.json");

// AgentLink data directory (can be overridden)
const DATA_DIR = process.env.AGENTLINK_DATA_DIR || path.join(os.homedir(), ".agentlink");
const IDENTITY_FILE = path.join(DATA_DIR, "identity.json");

const ID_CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateSuffix(len = 4) {
  return Array.from({ length: len }, () =>
    ID_CHARSET[Math.floor(Math.random() * ID_CHARSET.length)]
  ).join("");
}

function slugify(name) {
  // Normalize Unicode (e.g., Š → S)
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "agent";
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

function box(lines) {
  const maxLen = Math.max(...lines.map(l => l.length));
  const border = "─".repeat(maxLen + 4);
  console.log(`\n╭${border}╮`);
  lines.forEach(line => {
    const padding = " ".repeat(maxLen - line.length);
    console.log(`│  ${line}${padding}  │`);
  });
  console.log(`╰${border}╯\n`);
}

function detectIdentity() {
  // 1. Check existing identity.json
  if (fs.existsSync(IDENTITY_FILE)) {
    try {
      const identity = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf-8"));
      if (identity.agent_id && identity.human_name && identity.agent_name) {
        return { existing: true, ...identity };
      }
    } catch {}
  }

  // 2. Check OpenClaw plugin config
  let humanName = null;
  let agentName = null;

  if (fs.existsSync(OC_CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf-8"));
      const agentConfig = config?.plugins?.entries?.agentlink?.config?.agent;
      if (agentConfig?.human_name) {
        humanName = agentConfig.human_name;
      }
    } catch {}
  }

  // 3. Try USER.md for human name (skip if template)
  const userMdPath = path.join(os.homedir(), ".openclaw", "workspace", "USER.md");
  if (!humanName && fs.existsSync(userMdPath)) {
    try {
      const content = fs.readFileSync(userMdPath, "utf-8");
      const nameMatch = content.match(/^-\s*\*\*Name:\*\*\s+(.+)$/m);
      if (nameMatch && nameMatch[1].trim()) {
        const name = nameMatch[1].trim();
        if (name.length > 0 && !name.includes("_") && !name.includes("**") && !name.includes(":")) {
          humanName = name;
        }
      }
    } catch {}
  }

  // 4. Try IDENTITY.md for agent name
  const identityMdPath = path.join(os.homedir(), ".openclaw", "workspace", "IDENTITY.md");
  if (fs.existsSync(identityMdPath)) {
    try {
      const content = fs.readFileSync(identityMdPath, "utf-8");
      const nameMatch = content.match(/^-\s*\*\*Name:\*\*\s+(.+)$/m);
      if (nameMatch && nameMatch[1].trim()) {
        const name = nameMatch[1].trim();
        if (name.length > 0 && !name.includes("_") && !name.includes("**") && !name.includes(":")) {
          agentName = name;
        }
      }
    } catch {}
  }

  // 5. Try MEMORY.md as fallback for both names
  const memoryMdPath = path.join(os.homedir(), ".openclaw", "workspace", "MEMORY.md");
  if ((!humanName || !agentName) && fs.existsSync(memoryMdPath)) {
    try {
      const content = fs.readFileSync(memoryMdPath, "utf-8");

      // Look for "- Name: VALUE" (human name)
      if (!humanName) {
        const humanMatch = content.match(/^-\s*Name:\s+(.+)$/m);
        if (humanMatch && humanMatch[1].trim()) {
          humanName = humanMatch[1].trim();
        }
      }

      // Look for "I'm [AgentName]" pattern
      if (!agentName) {
        const agentMatch = content.match(/I'm\s+(\w+),/);
        if (agentMatch && agentMatch[1]) {
          agentName = agentMatch[1];
        }
      }
    } catch {}
  }

  // Determine sources
  let humanSource = null;
  let agentSource = null;

  if (humanName) {
    if (fs.existsSync(memoryMdPath)) {
      const memContent = fs.readFileSync(memoryMdPath, "utf-8");
      if (memContent.includes(`Name: ${humanName}`)) humanSource = "MEMORY.md";
    }
    if (!humanSource && fs.existsSync(userMdPath)) {
      const userContent = fs.readFileSync(userMdPath, "utf-8");
      if (userContent.includes(humanName)) humanSource = "USER.md";
    }
    if (!humanSource) humanSource = "openclaw.json";
  }

  if (agentName) {
    if (fs.existsSync(identityMdPath)) {
      const idContent = fs.readFileSync(identityMdPath, "utf-8");
      if (idContent.includes(agentName)) agentSource = "IDENTITY.md";
    }
    if (!agentSource && fs.existsSync(memoryMdPath)) {
      const memContent = fs.readFileSync(memoryMdPath, "utf-8");
      if (memContent.includes(`I'm ${agentName}`)) agentSource = "MEMORY.md";
    }
  }

  return {
    humanName: humanName || null,
    agentName: agentName || null,
    humanNameSource: humanSource,
    agentNameSource: agentSource,
  };
}

async function waitForGatewayRestart(maxWaitSeconds = 120) {
  const gatewayUrl = "ws://127.0.0.1:18789"; // TODO: Detect port from config
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;

  console.log(pc.dim(`\nWaiting for gateway restart (max ${maxWaitSeconds}s)...`));
  console.log(pc.dim(`You can manually restart with: openclaw gateway stop && openclaw gateway`));

  const spinner = ["|", "/", "-", "\\"];
  let spinnerIdx = 0;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Try to connect to gateway WS endpoint
      const ws = new WebSocket(gatewayUrl);

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), 2000);

        ws.on('open', () => {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        });

        ws.on('error', () => {
          clearTimeout(timeout);
          reject(new Error("connection failed"));
        });
      });

      // Gateway is up!
      console.log(pc.green(`\n✓ Gateway restarted successfully`));

      // Wait a bit for plugin to load
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify AgentLink loaded (check if identity.json exists and was processed)
      const identityPath = path.join(os.homedir(), ".agentlink", "identity.json");
      if (fs.existsSync(identityPath)) {
        console.log(pc.green(`✓ AgentLink plugin loaded`));
        return true;
      }

    } catch (err) {
      // Not ready yet, keep waiting
      process.stdout.write(`\r${spinner[spinnerIdx % 4]} Waiting... (${Math.floor((Date.now() - startTime) / 1000)}s)`);
      spinnerIdx++;
      await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2s
    }
  }

  // Timeout reached
  console.log(pc.yellow(`\n⚠ Timeout waiting for gateway restart`));
  console.log(pc.yellow(`Please manually restart: openclaw gateway stop && openclaw gateway`));
  return false;
}

async function setup(joinCode, humanNameArg, agentNameArg) {
  console.log("\n" + pc.bold("  AgentLink Setup") + "\n");

  // Step 1: Check for OpenClaw
  const spinner1 = ora("Checking for OpenClaw...").start();
  let ocPath;
  try {
    ocPath = execSync("which openclaw", { stdio: "pipe", encoding: "utf-8" }).trim();
    spinner1.succeed(`OpenClaw found: ${pc.dim(ocPath)}`);
  } catch {
    spinner1.fail("OpenClaw not found");
    console.error(pc.red("\n  Error: 'openclaw' CLI not found on PATH."));
    console.error(pc.dim("  Install OpenClaw first: https://openclaw.ai\n"));
    process.exit(1);
  }

  // Step 2: Check/generate identity
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const detected = detectIdentity();
  let identity;

  if (detected?.existing) {
    console.log(pc.green(`  ✓ Existing identity: ${detected.agent_id} (${detected.agent_name} for ${detected.human_name})`));
    identity = detected;
  } else {
    let humanName;
    let agentName;

    // Check if CLI arguments were provided (non-interactive mode)
    const isNonInteractive = humanNameArg || agentNameArg || joinCode;

    if (isNonInteractive) {
      // Use CLI args, then detected values, then defaults
      humanName = humanNameArg || detected.humanName || os.userInfo().username || "User";
      agentName = agentNameArg || detected.agentName || "Agent";

      console.log(pc.dim(`  Auto-configuring...`));
      if (humanNameArg) {
        console.log(pc.dim(`  Human name: ${humanName} (from --human-name)`));
      } else if (detected.humanName) {
        console.log(pc.dim(`  Human name: ${humanName} (from ${detected.humanNameSource})`));
      } else {
        console.log(pc.dim(`  Human name: ${humanName} (using system username)`));
      }

      if (agentNameArg) {
        console.log(pc.dim(`  Agent name: ${agentName} (from --agent-name)`));
      } else if (detected.agentName) {
        console.log(pc.dim(`  Agent name: ${agentName} (from ${detected.agentNameSource})`));
      } else {
        console.log(pc.dim(`  Agent name: ${agentName} (using default)`));
      }
    } else {
      // Interactive mode - ask for confirmation/input
      if (detected.humanName) {
        console.log(pc.dim(`\n  Detected from ${detected.humanNameSource}: ${pc.bold(detected.humanName)}`));
        const answer = await ask(`  Your name (press Enter to confirm, or type to change): `);
        humanName = answer || detected.humanName;
      } else {
        humanName = await ask("\n  What's your name? ");
      }

      if (!humanName) {
        console.error(pc.red("  Your name is required.\n"));
        process.exit(1);
      }

      if (detected.agentName) {
        console.log(pc.dim(`\n  Detected from ${detected.agentNameSource}: ${pc.bold(detected.agentName)}`));
        const answer = await ask(`  Agent name (press Enter to confirm, or type to change): `);
        agentName = answer || detected.agentName;
      } else {
        agentName = await ask("\n  What should your agent be called? ");
      }

      if (!agentName) {
        console.error(pc.red("  Agent name is required.\n"));
        process.exit(1);
      }
    }

    const agentId = `${slugify(agentName)}-${generateSuffix()}`;
    identity = { agent_id: agentId, human_name: humanName, agent_name: agentName };
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2) + "\n");
    console.log(pc.green(`  ✓ Agent ID: ${agentId}`));
    console.log(pc.dim(`  ${agentName} for ${humanName}`));
  }

  // Step 3: Install plugin with proper permission dance
  const spinner2 = ora("Installing AgentLink plugin...").start();

  try {
    // Read config
    let config = {};
    if (fs.existsSync(OC_CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf-8"));
    }

    // Save current plugins.allow (if exists)
    const hadPluginsAllow = config.plugins?.allow;

    // Temporarily remove plugins.allow to avoid chicken-and-egg
    if (config.plugins?.allow) {
      delete config.plugins.allow;
      fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(config, null, 2));
    }

    // Install plugin
    try {
      execSync("openclaw plugins install @agentlinkdev/agentlink", {
        stdio: "pipe",
        encoding: "utf-8"
      });
    } catch (installErr) {
      // Restore plugins.allow before failing
      if (hadPluginsAllow && fs.existsSync(OC_CONFIG_PATH)) {
        const restoreConfig = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf-8"));
        if (!restoreConfig.plugins) restoreConfig.plugins = {};
        restoreConfig.plugins.allow = hadPluginsAllow;
        fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(restoreConfig, null, 2));
      }
      throw installErr;
    }

    // Re-read config (plugin install may have modified it)
    config = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf-8"));

    // Re-add plugins.allow
    if (!config.plugins) config.plugins = {};
    config.plugins.allow = ["agentlink"];

    // Add tools.alsoAllow (CRITICAL: not tools.allow)
    if (!config.tools) config.tools = {};
    if (!config.tools.alsoAllow) config.tools.alsoAllow = [];
    if (!config.tools.alsoAllow.includes("agentlink")) {
      config.tools.alsoAllow.push("agentlink");
    }

    fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(config, null, 2));
    spinner2.succeed("Plugin installed");
    console.log(pc.green("  ✓ Permissions configured"));
  } catch (err) {
    spinner2.fail("Plugin installation failed");
    console.error(pc.red("\n  Error during plugin install:"));
    console.error(pc.dim(`  ${err.message}\n`));
    process.exit(1);
  }

  // Step 3.5: Watch for gateway restart
  const restarted = await waitForGatewayRestart(120);

  // Step 4: Handle invite code (if provided)
  if (joinCode) {
    const pendingFile = path.join(DATA_DIR, "pending_join.json");
    fs.writeFileSync(pendingFile, JSON.stringify({ code: joinCode }) + "\n");
    console.log(pc.green(`  ✓ Invite code ${joinCode} will be processed on gateway start`));
  }

  // Step 5: Success!
  console.log(pc.green("\n  ✓ Setup complete!\n"));
  console.log(pc.dim(`  Agent ID: ${identity.agent_id}`));
  console.log(pc.dim(`  Data dir: ${DATA_DIR}\n`));

  // Viral loop prompt with clear next steps
  if (joinCode) {
    if (restarted) {
      box([
        pc.bold(`✓ Connected with invite code ${joinCode}!`),
        "",
        "Gateway has restarted and AgentLink is active.",
        "An auto-hello will be sent to the inviter.",
        "",
        "Test it! Tell your agent:",
        pc.cyan(`   "Message them: hey, just set up AgentLink!"`),
      ]);
    } else {
      box([
        pc.bold(`✓ Connected with invite code ${joinCode}!`),
        "",
        "Next steps:",
        "",
        "1. Restart your gateway manually:",
        pc.cyan("   openclaw gateway stop && openclaw gateway"),
        "",
        "2. After restart, an auto-hello is sent to the inviter",
        "",
        "3. Test it! Tell your agent:",
        pc.cyan(`   "Message them: hey, just set up AgentLink!"`),
      ]);
    }
  } else {
    if (restarted) {
      box([
        pc.bold("✓ AgentLink is ready!"),
        "",
        "Gateway has restarted and AgentLink is active.",
        "",
        "Next step: Generate an invite to connect with someone:",
        pc.cyan(`   "Generate an AgentLink invite for [Name]"`),
      ]);
    } else {
      box([
        pc.bold("✓ AgentLink is ready!"),
        "",
        "Next steps:",
        "",
        "1. Restart your gateway manually:",
        pc.cyan("   openclaw gateway stop && openclaw gateway"),
        "",
        "2. Generate an invite to connect with someone:",
        pc.cyan(`   "Generate an AgentLink invite for [Name]"`),
      ]);
    }
  }
  console.log("");
}

function reset() {
  console.log("\n" + pc.bold(pc.yellow("  ⚠ AgentLink Reset")) + "\n");

  const identityPath = path.join(DATA_DIR, "identity.json");
  if (!fs.existsSync(identityPath)) {
    console.log(pc.yellow("  No AgentLink installation found."));
    process.exit(0);
  }

  // Read current identity to show what's being reset
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf-8"));
  console.log(pc.dim(`  Current agent: ${identity.agent_id}`));
  console.log(pc.dim(`  Human: ${identity.human_name}\n`));

  // Confirm
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(pc.yellow("  Clear all AgentLink data? (y/N): "), (answer) => {
    rl.close();

    if (answer.toLowerCase() !== "y") {
      console.log(pc.dim("  Reset cancelled.\n"));
      process.exit(0);
    }

    // Clear data
    console.log(pc.dim("\n  Removing:"));
    const files = fs.readdirSync(DATA_DIR);
    files.forEach(file => {
      const filePath = path.join(DATA_DIR, file);
      console.log(pc.dim(`    - ${file}`));
      if (fs.lstatSync(filePath).isDirectory()) {
        fs.rmSync(filePath, { recursive: true });
      } else {
        fs.unlinkSync(filePath);
      }
    });

    console.log(pc.green("\n  ✓ AgentLink data cleared"));
    console.log(pc.dim("  Plugin still installed in OpenClaw."));
    console.log(pc.dim("  Run `agentlink setup` to reconfigure.\n"));
  });
}

function uninstall() {
  console.log("\n" + pc.bold(pc.yellow("  ⚠ AgentLink Uninstall")) + "\n");

  // Check what's installed
  const hasData = fs.existsSync(path.join(DATA_DIR, "identity.json"));
  const hasPlugin = (() => {
    try {
      const result = execSync("openclaw plugins list", { encoding: "utf-8" });
      return result.includes("agentlink");
    } catch {
      return false;
    }
  })();

  if (!hasData && !hasPlugin) {
    console.log(pc.yellow("  No AgentLink installation found."));
    process.exit(0);
  }

  console.log(pc.dim("  Will remove:"));
  if (hasData) console.log(pc.dim(`    - AgentLink data (${DATA_DIR})`));
  if (hasPlugin) console.log(pc.dim("    - AgentLink plugin from OpenClaw"));
  console.log("");

  // Confirm
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(pc.yellow("  Completely remove AgentLink? (y/N): "), (answer) => {
    rl.close();

    if (answer.toLowerCase() !== "y") {
      console.log(pc.dim("  Uninstall cancelled.\n"));
      process.exit(0);
    }

    // Remove data
    if (hasData) {
      console.log(pc.dim("\n  Removing data directory..."));
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
      console.log(pc.green("  ✓ Data removed"));
    }

    // Remove plugin
    if (hasPlugin) {
      console.log(pc.dim("  Removing plugin from OpenClaw..."));
      try {
        execSync("openclaw plugins uninstall agentlink", { stdio: "pipe" });
        console.log(pc.green("  ✓ Plugin removed"));
      } catch (err) {
        console.log(pc.yellow("  ⚠ Plugin removal failed - you may need to remove manually"));
        console.log(pc.dim("  Run: openclaw plugins uninstall agentlink"));
      }
    }

    console.log(pc.green("\n  ✓ AgentLink completely removed"));
    console.log(pc.dim("  Restart your gateway to apply changes.\n"));
  });
}

function generateInviteCode() {
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No ambiguous chars
  return Array.from({ length: 6 }, () =>
    charset[Math.floor(Math.random() * charset.length)]
  ).join("");
}

async function generateInvite(recipientName) {
  console.log("\n" + pc.bold(pc.blue("  📞 AgentLink Invite Generator")) + "\n");

  // Check if AgentLink is set up
  const identityPath = path.join(DATA_DIR, "identity.json");
  if (!fs.existsSync(identityPath)) {
    console.log(pc.red("  ✗ AgentLink not set up"));
    console.log(pc.dim("  Run: agentlink setup\n"));
    process.exit(1);
  }

  const identity = JSON.parse(fs.readFileSync(identityPath, "utf-8"));
  const senderName = identity.human_name || "sender";
  const recipient = recipientName || "recipient";

  const spinner = ora("Generating invite...").start();

  // Generate invite
  const code = generateInviteCode();
  const expires = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const invite = {
    code,
    from: identity.agent_id,
    human_name: identity.human_name,
    expires,
  };

  // Publish to MQTT
  const brokerUrl = "mqtt://broker.emqx.io:1883";
  const client = mqtt.connect(brokerUrl);

  await new Promise((resolve, reject) => {
    client.on("connect", () => {
      const topic = `agentlink/invites/${code}`;
      client.publish(topic, JSON.stringify(invite), { retain: true, qos: 1 }, (err) => {
        client.end();
        if (err) reject(err);
        else resolve();
      });
    });
    client.on("error", reject);
    setTimeout(() => reject(new Error("MQTT connection timeout")), 10000);
  });

  spinner.succeed("Invite generated");

  // Get landing page URL (use default Vercel deployment)
  const landingPageBase = "https://website-agentlink.vercel.app";
  const inviteUrl = `${landingPageBase}/join/${code}.txt`;

  // Installation message for recipient
  const installMessage = [
    `Hi OpenClaw, I would like to install AgentLink. It allows you, my agent, to talk to other OpenClaws — so you can schedule stuff, share context, and coordinate without us going back and forth.`,
    ``,
    `AgentLink is a peer-to-peer messaging plugin (like WhatsApp for AI agents).`,
    `No credentials shared. Messages are direct over MQTT.`,
    ``,
    `Get started: ${inviteUrl}`,
    `(Takes 30 seconds)`,
  ].join("\n");

  // Display formatted message
  console.log("");
  console.log(pc.bold(`  Here's your AgentLink invite for ${pc.cyan(recipient)}.\n`));
  console.log(pc.dim("  ───────────────────────────────────────────\n"));
  console.log(pc.bold(`  Instructions for ${senderName}:`), `Please send the whole message below to ${recipient}.\n`);
  console.log(pc.dim("  ───────────────────────────────────────────\n"));
  console.log(pc.bold(`  Instructions for ${recipient}:`), `Please paste the installation message below in your OpenClaw.\n`);
  console.log(pc.dim("  ───────────────────────────────────────────\n"));
  console.log("  " + installMessage.split("\n").join("\n  "));
  console.log("");
  console.log(pc.dim("  ───────────────────────────────────────────\n"));
  console.log(pc.bold(`  Invite code: ${pc.cyan(code)}`), pc.dim(`(expires ${new Date(expires).toLocaleDateString()})\n`));
}

async function exportDebugLogs() {
  console.log("\n" + pc.bold(pc.blue("  📦 AgentLink Debug Export")) + "\n");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const exportDir = path.join(os.tmpdir(), `agentlink-debug-${timestamp}`);
  const exportName = `agentlink-debug-${timestamp}.tar.gz`;
  const exportPath = path.join(os.homedir(), exportName);

  // Create temp export directory
  fs.mkdirSync(exportDir, { recursive: true });

  const spinner = ora("Collecting diagnostic data...").start();
  const manifest = [];

  // 1. System Info
  spinner.text = "Collecting system info...";
  const systemInfo = {
    timestamp: new Date().toISOString(),
    platform: os.platform(),
    arch: os.arch(),
    osVersion: os.release(),
    nodeVersion: process.version,
    hostname: os.hostname(),
    username: os.userInfo().username,
  };

  // Get OpenClaw version
  try {
    const ocVersion = execSync("openclaw --version", { encoding: "utf-8" }).trim();
    systemInfo.openclawVersion = ocVersion;
  } catch {
    systemInfo.openclawVersion = "not found";
  }

  // Get AgentLink version
  try {
    const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), "../package.json");
    const pkgJson = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    systemInfo.agentlinkVersion = pkgJson.version;
  } catch {
    systemInfo.agentlinkVersion = "unknown";
  }

  fs.writeFileSync(
    path.join(exportDir, "system-info.json"),
    JSON.stringify(systemInfo, null, 2)
  );
  manifest.push("system-info.json - System and version information");

  // 2. AgentLink Data
  spinner.text = "Copying AgentLink data...";
  if (fs.existsSync(DATA_DIR)) {
    const agentlinkExportDir = path.join(exportDir, "agentlink-data");
    fs.mkdirSync(agentlinkExportDir);

    // Copy identity
    if (fs.existsSync(path.join(DATA_DIR, "identity.json"))) {
      fs.copyFileSync(
        path.join(DATA_DIR, "identity.json"),
        path.join(agentlinkExportDir, "identity.json")
      );
      manifest.push("agentlink-data/identity.json - Agent identity");
    }

    // Copy contacts
    if (fs.existsSync(path.join(DATA_DIR, "contacts.json"))) {
      fs.copyFileSync(
        path.join(DATA_DIR, "contacts.json"),
        path.join(agentlinkExportDir, "contacts.json")
      );
      manifest.push("agentlink-data/contacts.json - Contact list");
    }

    // Copy conversation logs
    const logsDir = path.join(DATA_DIR, "logs");
    if (fs.existsSync(logsDir)) {
      const logsExportDir = path.join(agentlinkExportDir, "logs");
      fs.mkdirSync(logsExportDir);
      const logFiles = fs.readdirSync(logsDir);
      logFiles.forEach(file => {
        fs.copyFileSync(
          path.join(logsDir, file),
          path.join(logsExportDir, file)
        );
      });
      manifest.push(`agentlink-data/logs/ - ${logFiles.length} conversation log(s)`);
    }
  } else {
    manifest.push("⚠ No AgentLink data found (~/.agentlink does not exist)");
  }

  // 3. OpenClaw Gateway Logs (filtered for AgentLink)
  spinner.text = "Extracting OpenClaw logs...";
  const ocLogPath = path.join(os.homedir(), ".openclaw/logs/gateway.log");
  if (fs.existsSync(ocLogPath)) {
    // Get last 500 lines of full log
    try {
      const fullLog = execSync(`tail -500 "${ocLogPath}"`, { encoding: "utf-8" });
      fs.writeFileSync(
        path.join(exportDir, "openclaw-gateway-recent.log"),
        fullLog
      );
      manifest.push("openclaw-gateway-recent.log - Last 500 lines of gateway log");
    } catch {}

    // Filter for AgentLink-specific lines
    try {
      const agentlinkLog = execSync(`grep -i agentlink "${ocLogPath}" || true`, { encoding: "utf-8" });
      fs.writeFileSync(
        path.join(exportDir, "openclaw-agentlink-only.log"),
        agentlinkLog
      );
      manifest.push("openclaw-agentlink-only.log - Gateway log filtered for AgentLink activity");
    } catch {}
  } else {
    manifest.push("⚠ OpenClaw gateway log not found at ~/.openclaw/logs/gateway.log");
  }

  // 4. OpenClaw Config (AgentLink plugin section)
  spinner.text = "Copying OpenClaw config...";
  if (fs.existsSync(OC_CONFIG_PATH)) {
    const ocConfig = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf-8"));

    // Extract relevant sections
    const relevantConfig = {
      plugins: ocConfig.plugins || {},
      tools: ocConfig.tools || {},
      gateway: {
        port: ocConfig.gateway?.port,
        mode: ocConfig.gateway?.mode,
        bind: ocConfig.gateway?.bind,
      },
    };

    fs.writeFileSync(
      path.join(exportDir, "openclaw-config-excerpt.json"),
      JSON.stringify(relevantConfig, null, 2)
    );
    manifest.push("openclaw-config-excerpt.json - Relevant OpenClaw configuration");
  } else {
    manifest.push("⚠ OpenClaw config not found");
  }

  // 5. Generate README
  spinner.text = "Generating README...";
  const identity = fs.existsSync(path.join(DATA_DIR, "identity.json"))
    ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, "identity.json"), "utf-8"))
    : null;

  const contacts = fs.existsSync(path.join(DATA_DIR, "contacts.json"))
    ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, "contacts.json"), "utf-8"))
    : null;

  const readme = `# AgentLink Debug Export
Generated: ${new Date().toISOString()}

## System Information
- Platform: ${systemInfo.platform} ${systemInfo.arch}
- OS Version: ${systemInfo.osVersion}
- Node.js: ${systemInfo.nodeVersion}
- OpenClaw: ${systemInfo.openclawVersion}
- AgentLink: ${systemInfo.agentlinkVersion}

## Agent Information
${identity ? `- Agent ID: ${identity.agent_id}
- Human Name: ${identity.human_name}
- Agent Name: ${identity.agent_name}` : "⚠ No identity found"}

## Contacts
${contacts ? `${Object.keys(contacts.contacts || {}).length} contact(s)` : "⚠ No contacts file found"}

## Files Included

${manifest.map(item => `- ${item}`).join('\n')}

## Privacy Note
This export contains:
- Your agent identity and contact list
- Conversation logs (if any)
- OpenClaw configuration (plugin settings only, no API keys)
- Gateway logs (filtered for AgentLink activity)

**No API keys or sensitive credentials are included.**

## Sharing This Export
1. Review the contents to ensure you're comfortable sharing
2. Share the .tar.gz file via email or file transfer
3. Include a description of the issue you're experiencing

## Support
- GitHub Issues: https://github.com/agentlink-dev/agentlink/issues
- Email: hello@agent.lk
`;

  fs.writeFileSync(path.join(exportDir, "README.md"), readme);

  // 6. Create tarball
  spinner.text = "Creating archive...";
  try {
    execSync(`tar -czf "${exportPath}" -C "${path.dirname(exportDir)}" "${path.basename(exportDir)}"`, {
      stdio: "pipe",
    });
  } catch (err) {
    spinner.fail("Failed to create tarball");
    console.error(pc.red(`\n  Error: ${err.message}\n`));
    process.exit(1);
  }

  // Clean up temp directory
  fs.rmSync(exportDir, { recursive: true });

  spinner.succeed("Debug export created");

  // Show summary
  console.log("");
  console.log(pc.bold("  Export Summary:"));
  console.log(pc.dim(`  Location: ${exportPath}`));
  const sizeMB = (fs.statSync(exportPath).size / 1024).toFixed(1);
  console.log(pc.dim(`  Size: ${sizeMB} KB`));
  console.log("");

  if (identity) {
    console.log(pc.dim(`  Agent: ${identity.agent_id} (${identity.human_name})`));
  }
  if (contacts) {
    const contactCount = Object.keys(contacts.contacts || {}).length;
    console.log(pc.dim(`  Contacts: ${contactCount}`));
  }

  console.log("");
  console.log(pc.green("  ✓ Debug export ready to share"));
  console.log(pc.dim("  Review README.md inside the archive for details.\n"));
}

// --- Main ---
const args = process.argv.slice(2);
const command = args[0];

if (command === "setup") {
  const joinIdx = args.indexOf("--join");
  const joinCode = joinIdx >= 0 ? args[joinIdx + 1] : undefined;

  const humanNameIdx = args.indexOf("--human-name");
  const humanNameArg = humanNameIdx >= 0 ? args[humanNameIdx + 1] : undefined;

  const agentNameIdx = args.indexOf("--agent-name");
  const agentNameArg = agentNameIdx >= 0 ? args[agentNameIdx + 1] : undefined;

  setup(joinCode, humanNameArg, agentNameArg);
} else if (command === "invite") {
  const recipientIdx = args.indexOf("--recipient-name");
  const recipientName = recipientIdx >= 0 ? args[recipientIdx + 1] : undefined;
  await generateInvite(recipientName);
} else if (command === "reset") {
  reset();
} else if (command === "uninstall") {
  uninstall();
} else if (command === "debug") {
  await exportDebugLogs();
} else {
  console.log("\n" + pc.bold("  AgentLink CLI") + "\n");
  console.log("  Commands:");
  console.log("    " + pc.cyan("agentlink setup [--join CODE] [--human-name NAME] [--agent-name NAME]"));
  console.log("      " + pc.dim("Set up AgentLink and optionally join with an invite code\n"));
  console.log("    " + pc.cyan("agentlink invite [--recipient-name NAME]"));
  console.log("      " + pc.dim("Generate an invite code to share with someone\n"));
  console.log("    " + pc.cyan("agentlink reset"));
  console.log("      " + pc.dim("Clear AgentLink data (keeps plugin installed)\n"));
  console.log("    " + pc.cyan("agentlink uninstall"));
  console.log("      " + pc.dim("Completely remove AgentLink\n"));
  console.log("    " + pc.cyan("agentlink debug"));
  console.log("      " + pc.dim("Export diagnostic logs for troubleshooting\n"));
  console.log("  Examples:");
  console.log("    " + pc.cyan("agentlink setup"));
  console.log("    " + pc.cyan("agentlink setup --join ABC123 --human-name \"Alice\" --agent-name \"Agent A\""));
  console.log("    " + pc.cyan("agentlink invite --recipient-name \"Bob\""));
  console.log("    " + pc.cyan("agentlink reset"));
  console.log("    " + pc.cyan("agentlink uninstall"));
  console.log("    " + pc.cyan("agentlink debug") + "\n");
}
