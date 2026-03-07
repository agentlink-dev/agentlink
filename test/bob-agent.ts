#!/usr/bin/env npx tsx
/**
 * Bob Agent — simulated second agent for live UI testing.
 *
 * Connects to MQTT, auto-accepts invites, auto-responds to jobs.
 * Run in a terminal while you chat with agent A through the OC web UI.
 *
 * Usage:
 *   npx tsx test/bob-agent.ts
 *   # or
 *   npm run bob
 *
 * Prerequisites:
 *   - OC gateway running with AgentLink installed
 *   - Bob contact added (this script does it automatically)
 */

import mqtt from "mqtt";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TOPICS, createEnvelope } from "../src/types.js";
import type { MessageEnvelope, InviteMessage, AgentStatus } from "../src/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BROKER = "mqtt://broker.emqx.io:1883";
const BOB_ID = "agent-test-bob";
const DATA_DIR = path.join(os.homedir(), ".agentlink");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");

// Canned responses per capability (or a default)
const RESPONSES: Record<string, string> = {
  food_preference: "I love Italian food! How about a pasta place? Trattoria on Main St is great — cozy, reasonable prices, and they do a killer carbonara.",
  check_calendar: "I'm free Saturday from 6pm onwards. Sunday works too, any time after noon.",
  suggest_restaurants: "Based on what you're looking for: 1) Trattoria on Main St (Italian, $$), 2) Sakura (Japanese, $$$), 3) The Grill House (American, $$). I'd go with Trattoria personally.",
  book_reservation: "Reservation confirmed! Trattoria on Main St, Saturday 7pm, party of 2.",
  read_files: "README.md, notes.txt, todo.md, budget.csv",
};
const DEFAULT_RESPONSE = "Done! Let me know if you need anything else.";

// Bob's capabilities (advertised to the group)
const BOB_CAPABILITIES = [
  { name: "food_preference", description: "Share food preferences and restaurant opinions", input_hint: "Ask about cuisine or restaurants" },
  { name: "check_calendar", description: "Check Bob's calendar availability", input_hint: "Date/time range" },
  { name: "suggest_restaurants", description: "Suggest restaurants", input_hint: "Cuisine, location, party size" },
];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const BLUE = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`  ${DIM}${ts}${RESET} ${msg}`);
}

function logRecv(label: string, detail: string) {
  log(`${BLUE}← ${label}${RESET}  ${detail}`);
}

function logSend(label: string, detail: string) {
  log(`${GREEN}→ ${label}${RESET}  ${detail}`);
}

function logInfo(msg: string) {
  log(`${YELLOW}${msg}${RESET}`);
}

// ---------------------------------------------------------------------------
// Contacts: ensure bob is in agent A's contacts
// ---------------------------------------------------------------------------

function ensureBobContact() {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf-8"));
  } catch { /* empty */ }

  const contacts = (data.contacts as Record<string, unknown>) ?? {};
  if ((contacts.bob as Record<string, unknown>)?.agent_id === BOB_ID) {
    logInfo("Contact 'bob' already exists");
    return;
  }
  contacts["bob"] = { agent_id: BOB_ID, added: new Date().toISOString().split("T")[0] };
  data.contacts = contacts;
  fs.mkdirSync(path.dirname(CONTACTS_FILE), { recursive: true });
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2));
  logInfo("Added contact: bob → " + BOB_ID);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`
  ${GREEN}╔══════════════════════════════════════╗
  ║         Bob Agent (test agent)       ║
  ╚══════════════════════════════════════╝${RESET}

  Agent ID:  ${BOB_ID}
  Broker:    ${BROKER}
  Mode:      auto-accept invites, auto-respond to jobs

  Waiting for messages... (Ctrl+C to stop)
`);

  // Ensure bob is in agent A's contacts
  ensureBobContact();

  // Connect to MQTT
  const client = mqtt.connect(BROKER, {
    clientId: `agentlink-${BOB_ID}-${Date.now()}`,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 5000,
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MQTT connect timeout")), 10_000);
    client.on("connect", () => {
      clearTimeout(timeout);
      logInfo("Connected to broker");
      resolve();
    });
    client.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Subscribe to inbox
  await new Promise<void>((resolve, reject) => {
    client.subscribe(TOPICS.inbox(BOB_ID), { qos: 1 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  logInfo("Subscribed to inbox");

  // Track active groups for cleanup
  const activeGroups = new Set<string>();

  // -------------------------------------------------------------------------
  // Message handler
  // -------------------------------------------------------------------------
  client.on("message", async (topic, payload) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString());
    } catch {
      return; // ignore non-JSON (e.g. retained status clears)
    }

    // ----- Inbox: invites -----
    if (topic === TOPICS.inbox(BOB_ID)) {
      const msg = parsed as Record<string, unknown>;
      if (msg.type === "invite") {
        const invite = msg as unknown as InviteMessage;
        logRecv("INVITE", `from ${invite.from} — "${invite.goal}"`);

        // Auto-join
        const groupId = invite.group_id;
        activeGroups.add(groupId);

        // Subscribe to group
        client.subscribe(TOPICS.groupAll(groupId), { qos: 1 });
        logInfo(`Joined group ${groupId.slice(0, 8)}...`);

        // Publish status (retained)
        const status: AgentStatus = {
          agent_id: BOB_ID,
          owner: "Bob",
          status: "online",
          capabilities: BOB_CAPABILITIES,
          description: "Bob's agent (test)",
          ts: new Date().toISOString(),
        };
        client.publish(
          TOPICS.groupStatus(groupId, BOB_ID),
          JSON.stringify(status),
          { qos: 1, retain: true },
        );
        logSend("STATUS", "online + capabilities");

        // Publish join system message
        const joinMsg = createEnvelope(BOB_ID, {
          group_id: groupId,
          to: "group",
          type: "join",
          payload: { text: `${BOB_ID} joined the group` },
        });
        client.publish(
          TOPICS.groupSystem(groupId),
          JSON.stringify(joinMsg),
          { qos: 1 },
        );
        logSend("JOIN", `group ${groupId.slice(0, 8)}...`);
        return;
      }
    }

    // ----- Group messages -----
    const groupMsgMatch = topic.match(/^agentlink\/([^/]+)\/messages\/.+$/);
    if (groupMsgMatch) {
      const envelope = parsed as MessageEnvelope;
      if (envelope.from === BOB_ID) return; // ignore echo

      if (envelope.type === "job_request") {
        const cap = envelope.payload.capability ?? "unknown";
        const text = envelope.payload.text ?? "(no text)";
        logRecv("JOB", `[${cap}] "${text}"`);

        // Pick response based on capability
        const response = RESPONSES[cap] ?? DEFAULT_RESPONSE;

        // Send response
        const responseMsg = createEnvelope(BOB_ID, {
          group_id: envelope.group_id,
          to: envelope.from,
          type: "job_response",
          correlation_id: envelope.correlation_id,
          payload: {
            text: response,
            capability: cap,
            status: "completed",
            result: response,
          },
        });
        client.publish(
          TOPICS.groupMessages(envelope.group_id, BOB_ID),
          JSON.stringify(responseMsg),
          { qos: 1 },
        );
        logSend("RESPONSE", `"${response.slice(0, 80)}${response.length > 80 ? "..." : ""}"`);
        return;
      }

      if (envelope.type === "chat") {
        logRecv("CHAT", `from ${envelope.from}: "${envelope.payload.text ?? ""}"`);
        return;
      }

      logRecv(envelope.type.toUpperCase(), `from ${envelope.from}`);
      return;
    }

    // ----- System events -----
    if (topic.match(/^agentlink\/[^/]+\/system$/)) {
      const envelope = parsed as MessageEnvelope;
      if (envelope.from === BOB_ID) return;

      if (envelope.type === "leave") {
        logRecv("COMPLETE", `Group closed by ${envelope.from}: "${envelope.payload?.text ?? ""}"`);
        // Clean up
        const groupId = envelope.group_id;
        if (groupId && activeGroups.has(groupId)) {
          client.publish(TOPICS.groupStatus(groupId, BOB_ID), "", { retain: true });
          client.unsubscribe(TOPICS.groupAll(groupId));
          activeGroups.delete(groupId);
          logInfo(`Left group ${groupId.slice(0, 8)}...`);
        }
        return;
      }

      logRecv("SYSTEM", `[${(parsed as Record<string, unknown>).type}] from ${(parsed as Record<string, unknown>).from}`);
      return;
    }
  });

  // Handle reconnect
  client.on("reconnect", () => logInfo("Reconnecting..."));
  client.on("offline", () => logInfo("Connection lost"));
  client.on("connect", () => {
    // Resubscribe on reconnect
    client.subscribe(TOPICS.inbox(BOB_ID), { qos: 1 });
    for (const groupId of activeGroups) {
      client.subscribe(TOPICS.groupAll(groupId), { qos: 1 });
    }
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("");
    logInfo("Shutting down...");
    // Clear retained statuses
    for (const groupId of activeGroups) {
      client.publish(TOPICS.groupStatus(groupId, BOB_ID), "", { retain: true });
    }
    client.end(false, {}, () => {
      logInfo("Disconnected. Bye!");
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error(`\n  FATAL: ${err.message ?? err}\n`);
  process.exit(1);
});
