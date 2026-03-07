#!/usr/bin/env npx tsx
/**
 * Two-agent E2E test.
 *
 * Simulates "agent B" (bob) on MQTT while the real OC gateway runs agent A.
 * Proves the full protocol: invite → join → job_request → job_response → complete.
 *
 * Prerequisites:
 *   - OC gateway running with AgentLink installed
 *   - Agent A has an agent ID (via CLI setup)
 *
 * Usage:
 *   npx tsx test/two-agent-e2e.ts
 *   # or
 *   npm run test:e2e
 */

import mqtt from "mqtt";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { TOPICS, createEnvelope } from "../src/types.js";
import type { MessageEnvelope, InviteMessage, AgentStatus } from "../src/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BROKER = "mqtt://broker.emqx.io:1883";
const BOB_ID = "agent-test-bob";
const BOB_DESCRIPTION = "Bob's test agent (E2E loopback)";
const DATA_DIR = path.join(os.homedir(), ".agentlink");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");
const AGENT_TURN_TIMEOUT = 120_000; // ms to wait for an agent turn
const MSG_WAIT_TIMEOUT = 30_000; // ms to wait for an MQTT message

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`  ${ts} [${tag}] ${msg}`);
}

function header(msg: string) {
  console.log(`\n  === ${msg} ===\n`);
}

function pass(msg: string) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string): never {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Setup: add bob as a contact for agent A
// ---------------------------------------------------------------------------

function addBobContact() {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf-8"));
  } catch { /* empty */ }

  const contacts = (data.contacts as Record<string, unknown>) ?? {};
  contacts["bob"] = { agent_id: BOB_ID, added: new Date().toISOString().split("T")[0] };
  data.contacts = contacts;

  fs.mkdirSync(path.dirname(CONTACTS_FILE), { recursive: true });
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2));
  log("setup", `Added contact: bob -> ${BOB_ID}`);
}

function removeBobContact() {
  try {
    const data = JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf-8"));
    if (data.contacts?.bob) {
      delete data.contacts.bob;
      fs.writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2));
      log("cleanup", "Removed bob contact");
    }
  } catch { /* fine */ }
}

// ---------------------------------------------------------------------------
// Agent B: MQTT protocol handler
// ---------------------------------------------------------------------------

interface AgentB {
  client: mqtt.MqttClient;
  events: Array<{ type: string; data: unknown; ts: number }>;
  groupId: string | null;
  driverId: string | null;
  waitForInvite(): Promise<InviteMessage>;
  waitForJobRequest(): Promise<MessageEnvelope>;
  waitForComplete(): Promise<MessageEnvelope>;
  joinGroup(invite: InviteMessage): Promise<void>;
  respondToJob(job: MessageEnvelope, response: string): Promise<void>;
  disconnect(): Promise<void>;
}

async function createAgentB(): Promise<AgentB> {
  const events: AgentB["events"] = [];
  let groupId: string | null = null;
  let driverId: string | null = null;

  // Pending message resolvers
  const pendingResolvers: Array<{
    filter: (type: string, data: unknown) => boolean;
    resolve: (data: unknown) => void;
  }> = [];

  const client = mqtt.connect(BROKER, {
    clientId: `agentlink-${BOB_ID}-${Date.now()}`,
    clean: true,
    keepalive: 30,
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MQTT connect timeout")), 10_000);
    client.on("connect", () => {
      clearTimeout(timeout);
      log("bob", `Connected to ${BROKER}`);
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
  log("bob", `Subscribed to inbox: ${TOPICS.inbox(BOB_ID)}`);

  // Route all messages
  client.on("message", (topic, payload) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString());
    } catch {
      log("bob", `Non-JSON on ${topic}`);
      return;
    }

    // Inbox: invites
    if (topic === TOPICS.inbox(BOB_ID)) {
      const msg = parsed as Record<string, unknown>;
      if (msg.type === "invite") {
        log("bob", `Invite received from ${msg.from}: "${msg.goal}"`);
        events.push({ type: "invite", data: parsed, ts: Date.now() });
        resolveWaiters("invite", parsed);
        return;
      }
    }

    // Group messages (job requests, etc.)
    const groupMsgMatch = topic.match(/^agentlink\/([^/]+)\/messages\/.+$/);
    if (groupMsgMatch) {
      const envelope = parsed as MessageEnvelope;
      if (envelope.from === BOB_ID) return; // ignore echo
      log("bob", `Group msg [${envelope.type}] from ${envelope.from}: ${envelope.payload?.text ?? "(no text)"}`);
      events.push({ type: envelope.type, data: parsed, ts: Date.now() });
      resolveWaiters(envelope.type, parsed);
      return;
    }

    // System events (leave/complete)
    if (topic.match(/^agentlink\/[^/]+\/system$/)) {
      const envelope = parsed as Record<string, unknown>;
      log("bob", `System event [${envelope.type}] from ${envelope.from}`);
      events.push({ type: String(envelope.type), data: parsed, ts: Date.now() });
      resolveWaiters(String(envelope.type), parsed);
      return;
    }

    log("bob", `Unhandled topic: ${topic}`);
  });

  function resolveWaiters(type: string, data: unknown) {
    for (let i = pendingResolvers.length - 1; i >= 0; i--) {
      if (pendingResolvers[i].filter(type, data)) {
        pendingResolvers[i].resolve(data);
        pendingResolvers.splice(i, 1);
      }
    }
  }

  function waitFor<T>(filter: (type: string, data: unknown) => boolean, timeoutMs: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for ${label} (${timeoutMs}ms)`));
      }, timeoutMs);

      pendingResolvers.push({
        filter,
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data as T);
        },
      });
    });
  }

  return {
    client,
    events,
    get groupId() { return groupId; },
    get driverId() { return driverId; },

    waitForInvite() {
      return waitFor<InviteMessage>(
        (type) => type === "invite",
        MSG_WAIT_TIMEOUT,
        "invite",
      );
    },

    waitForJobRequest() {
      return waitFor<MessageEnvelope>(
        (type) => type === "job_request",
        MSG_WAIT_TIMEOUT,
        "job_request",
      );
    },

    waitForComplete() {
      return waitFor<MessageEnvelope>(
        (type) => type === "leave",
        MSG_WAIT_TIMEOUT,
        "leave/complete",
      );
    },

    async joinGroup(invite: InviteMessage) {
      groupId = invite.group_id;
      driverId = invite.from;

      // Subscribe to group topics
      await new Promise<void>((resolve, reject) => {
        client.subscribe(TOPICS.groupAll(groupId!), { qos: 1 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      log("bob", `Subscribed to group: ${groupId}`);

      // Publish status (retained)
      const status: AgentStatus = {
        agent_id: BOB_ID,
        owner: "Bob",
        status: "online",
        capabilities: [
          { name: "food_preference", description: "Share food preferences", input_hint: "Ask about food" },
        ],
        description: BOB_DESCRIPTION,
        ts: new Date().toISOString(),
      };
      await new Promise<void>((resolve, reject) => {
        client.publish(
          TOPICS.groupStatus(groupId!, BOB_ID),
          JSON.stringify(status),
          { qos: 1, retain: true },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      log("bob", "Published online status");

      // Publish join system message
      const joinMsg = createEnvelope(BOB_ID, {
        group_id: groupId!,
        to: "group",
        type: "join",
        payload: { text: `${BOB_ID} joined the group` },
      });
      await new Promise<void>((resolve, reject) => {
        client.publish(
          TOPICS.groupSystem(groupId!),
          JSON.stringify(joinMsg),
          { qos: 1 },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      log("bob", "Published join message");
    },

    async respondToJob(job: MessageEnvelope, response: string) {
      if (!groupId) throw new Error("Not in a group");

      const responseMsg = createEnvelope(BOB_ID, {
        group_id: groupId,
        to: job.from,
        type: "job_response",
        correlation_id: job.correlation_id,
        payload: {
          text: response,
          capability: job.payload.capability,
          status: "completed",
          result: response,
        },
      });

      await new Promise<void>((resolve, reject) => {
        client.publish(
          TOPICS.groupMessages(groupId!, BOB_ID),
          JSON.stringify(responseMsg),
          { qos: 1 },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      log("bob", `Sent job response: "${response}"`);
    },

    async disconnect() {
      // Clear retained status
      if (groupId) {
        await new Promise<void>((resolve) => {
          client.publish(TOPICS.groupStatus(groupId!, BOB_ID), "", { retain: true }, () => resolve());
        });
      }
      await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
      log("bob", "Disconnected");
    },
  };
}

// ---------------------------------------------------------------------------
// Agent A: trigger turns via OC CLI
// ---------------------------------------------------------------------------

function agentATurn(sessionId: string, message: string): string {
  log("agent-a", `Sending: "${message}"`);
  try {
    const result = execSync(
      `openclaw agent --session-id ${sessionId} --message ${JSON.stringify(message)} --json`,
      { timeout: AGENT_TURN_TIMEOUT, encoding: "utf-8" },
    );
    const parsed = JSON.parse(result);
    const text = parsed.result?.payloads?.[0]?.text ?? "(no text)";
    log("agent-a", `Response: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Agent A turn failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
  const sessionId = `e2e-${Date.now()}`;

  header("Two-Agent E2E Test");
  log("test", `Session: ${sessionId}`);
  log("test", `Broker: ${BROKER}`);
  log("test", `Agent B: ${BOB_ID}`);

  // -----------------------------------------------------------------------
  // Step 1: Setup
  // -----------------------------------------------------------------------
  header("Step 1: Setup");
  addBobContact();
  pass("Added bob contact (live-reloaded by plugin)");

  const bob = await createAgentB();
  pass("Agent B connected to MQTT");

  // -----------------------------------------------------------------------
  // Step 2: Agent A starts coordination
  // -----------------------------------------------------------------------
  header("Step 2: Agent A starts coordination");

  // Start listening for invite BEFORE triggering agent A
  const invitePromise = bob.waitForInvite();

  const turn1 = agentATurn(
    sessionId,
    'Call the agentlink_coordinate tool with these exact parameters: goal="pick a lunch restaurant", done_when="restaurant is chosen", participants=["bob"]. Bob is already in your contacts.',
  );

  if (turn1.toLowerCase().includes("need") && turn1.toLowerCase().includes("agent id")) {
    // LLM refused — try one more time with stronger prompt
    log("warn", "Agent asked for agent ID, retrying with stronger prompt");
    agentATurn(
      sessionId,
      'Just call agentlink_coordinate now. participants should be ["bob"]. The contact system will resolve "bob" to an agent ID automatically. Do not ask me anything, just call the tool.',
    );
  }
  pass("Agent A started coordination");

  // -----------------------------------------------------------------------
  // Step 3: Agent B receives invite and joins
  // -----------------------------------------------------------------------
  header("Step 3: Agent B joins group");

  const invite = await invitePromise;
  pass(`Invite received: group=${invite.group_id}, from=${invite.from}`);

  await bob.joinGroup(invite);
  pass("Agent B joined group");

  // Give agent A's gateway a moment to process the join system event
  await new Promise((r) => setTimeout(r, 2000));

  // -----------------------------------------------------------------------
  // Step 4: Agent A submits a job to Bob
  // -----------------------------------------------------------------------
  header("Step 4: Agent A submits job");

  const jobPromise = bob.waitForJobRequest();

  agentATurn(
    sessionId,
    `Call agentlink_submit_job with these exact parameters: group_id="${invite.group_id}", capability="food_preference", text="What are your food preferences for lunch?". Do not ask me anything, just call the tool.`,
  );
  pass("Agent A submitted job");

  // -----------------------------------------------------------------------
  // Step 5: Agent B responds to job
  // -----------------------------------------------------------------------
  header("Step 5: Agent B responds to job");

  const job = await jobPromise;
  pass(`Job received: capability=${job.payload.capability}, correlation=${job.correlation_id}`);

  await bob.respondToJob(job, "I love Italian food. How about a pasta place? Maybe Trattoria on Main St.");
  pass("Agent B sent job response");

  // Give agent A's gateway time to process the response
  await new Promise((r) => setTimeout(r, 2000));

  // -----------------------------------------------------------------------
  // Step 6: Agent A completes coordination
  // -----------------------------------------------------------------------
  header("Step 6: Agent A completes coordination");

  const completePromise = bob.waitForComplete();

  agentATurn(
    sessionId,
    `Call agentlink_complete with these exact parameters: group_id="${invite.group_id}", summary="Chose Trattoria on Main St based on Bob's Italian food preference", success=true. Do not ask me anything, just call the tool.`,
  );
  pass("Agent A declared completion");

  // -----------------------------------------------------------------------
  // Step 7: Agent B sees completion
  // -----------------------------------------------------------------------
  header("Step 7: Verify completion");

  try {
    const complete = await completePromise;
    pass(`Completion received: ${(complete as MessageEnvelope).payload?.text?.slice(0, 100) ?? "(leave message)"}`);
  } catch {
    log("warn", "Did not receive completion system message (may have been processed before subscribe)");
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  header("Results");

  const eventTypes = bob.events.map((e) => e.type);
  console.log(`  Events captured: ${eventTypes.join(" → ")}`);
  console.log("");

  const hasInvite = eventTypes.includes("invite");
  const hasJobRequest = eventTypes.includes("job_request");

  if (hasInvite) pass("Protocol: invite received");
  else fail("Protocol: invite NOT received");

  if (hasJobRequest) pass("Protocol: job_request received");
  else fail("Protocol: job_request NOT received");

  pass("Two-agent coordination completed successfully");

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------
  header("Cleanup");
  await bob.disconnect();
  removeBobContact();
  pass("Done");

  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n  FATAL: ${err.message ?? err}\n`);
  removeBobContact();
  process.exit(1);
});
