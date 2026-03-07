# AgentLink V1: Engineering Specification

> Implementation spec for `@agentlinkdev/openclaw` — the OpenClaw plugin that lets agents coordinate across machines via MQTT.
>
> **Read [PLAN.md](PLAN.md) first.** This document assumes familiarity with the design decisions, product thesis, and architecture described there. This spec covers _how to build it_, not _why_.

---

## Table of Contents

1. [Project Setup](#1-project-setup)
2. [Plugin Manifest & Config Schema](#2-plugin-manifest--config-schema)
3. [Plugin Entry Point (index.ts)](#3-plugin-entry-point-indexts)
4. [Types (types.ts)](#4-types-typests)
5. [MQTT Client (mqtt-client.ts)](#5-mqtt-client-mqtt-clientts)
6. [Background Service (mqtt-service.ts)](#6-background-service-mqtt-servicets)
7. [Contacts Store (contacts.ts)](#7-contacts-store-contactsts)
8. [Local State (state.ts)](#8-local-state-statets)
9. [Invite System (invite.ts)](#9-invite-system-invitets)
10. [Routing (routing.ts)](#10-routing-routingts)
11. [Job Lifecycle (jobs.ts)](#11-job-lifecycle-jobsts)
12. [Agent Tools (tools.ts)](#12-agent-tools-toolsts)
13. [Channel Plugin (channel.ts)](#13-channel-plugin-channelts)
14. [Message Handling Pipeline](#14-message-handling-pipeline)
15. [Anti-Deadlock Enforcement](#15-anti-deadlock-enforcement)
16. [Error Handling](#16-error-handling)
17. [Testing Strategy](#17-testing-strategy)
18. [File-by-File Build Order](#18-file-by-file-build-order)

---

## 1. Project Setup

### Directory Structure

```
@agentlinkdev/openclaw/
  openclaw.plugin.json
  package.json
  tsconfig.json
  src/
    index.ts
    channel.ts
    mqtt-client.ts
    mqtt-service.ts
    tools.ts
    routing.ts
    jobs.ts
    types.ts
    invite.ts
    contacts.ts
    state.ts
  test/
    mqtt-client.test.ts
    routing.test.ts
    jobs.test.ts
    state.test.ts
    contacts.test.ts
    invite.test.ts
    tools.test.ts
    e2e/
      two-agents.test.ts
```

### package.json

```json
{
  "name": "@agentlinkdev/openclaw",
  "version": "0.1.0",
  "description": "Agent-to-agent coordination for OpenClaw",
  "main": "src/index.ts",
  "openclaw": {
    "extensions": ["./src/index.ts"]
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "mqtt": "^5.10.0",
    "uuid": "^11.0.0"
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "typescript": "^5.7.0",
    "eslint": "^9.0.0",
    "@types/uuid": "^10.0.0"
  },
  "peerDependencies": {
    "openclaw": "*"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

---

## 2. Plugin Manifest & Config Schema

### openclaw.plugin.json

```json
{
  "id": "agentlink",
  "name": "AgentLink",
  "description": "Agent-to-agent coordination via MQTT. Your agent talks to other people's agents.",
  "version": "0.1.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["brokerUrl", "agent"],
    "properties": {
      "brokerUrl": {
        "type": "string",
        "description": "MQTT broker URL (mqtts:// for TLS, mqtt:// for local dev)",
        "default": "mqtts://broker.agentlink.dev:8883"
      },
      "brokerUsername": {
        "type": "string",
        "description": "MQTT broker username"
      },
      "brokerPassword": {
        "type": "string",
        "description": "MQTT broker password"
      },
      "agent": {
        "type": "object",
        "required": ["id"],
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "description": "Unique agent identifier (e.g. rupul-macbook)",
            "pattern": "^[a-z0-9][a-z0-9\\-]{2,39}$"
          },
          "description": {
            "type": "string",
            "description": "Human-readable agent description"
          },
          "capabilities": {
            "type": "array",
            "maxItems": 5,
            "items": {
              "type": "object",
              "required": ["name", "tool"],
              "properties": {
                "name": {
                  "type": "string",
                  "description": "Capability name (exact match for routing)"
                },
                "tool": {
                  "type": "string",
                  "description": "OpenClaw tool ID this capability maps to"
                },
                "description": {
                  "type": "string",
                  "description": "What this capability does (consumed by requesting agent's LLM)"
                },
                "input_hint": {
                  "type": "string",
                  "description": "What input the capability expects"
                }
              }
            }
          }
        }
      },
      "output_mode": {
        "type": "string",
        "enum": ["user", "debug"],
        "default": "user",
        "description": "user = outcomes only, debug = coordination steps visible"
      },
      "job_timeout_ms": {
        "type": "number",
        "default": 60000,
        "description": "Job timeout in milliseconds"
      },
      "data_dir": {
        "type": "string",
        "description": "Override data directory (default: ~/.agentlink)"
      }
    }
  },
  "uiHints": {
    "brokerUrl": { "label": "Broker URL", "placeholder": "mqtts://broker.agentlink.dev:8883" },
    "brokerUsername": { "label": "Broker Username" },
    "brokerPassword": { "label": "Broker Password", "sensitive": true },
    "agent.id": { "label": "Agent ID", "placeholder": "rupul-macbook" },
    "output_mode": { "label": "Output Mode" }
  }
}
```

### Config Resolution

The plugin config is read from `plugins.entries.agentlink.config` in the OpenClaw config. At plugin load time:

1. Validate config against `configSchema` (OpenClaw does this automatically)
2. Resolve `data_dir` — default to `~/.agentlink` via `os.homedir()` + `/.agentlink`
3. Ensure `data_dir` exists (create if missing)
4. Load `contacts.json` and `state.json` from `data_dir`

---

## 3. Plugin Entry Point (index.ts)

The plugin exports a registration function. This is the single entry point OpenClaw calls.

```typescript
import type { PluginApi } from "openclaw/plugin-sdk/core";
import { createMqttService } from "./mqtt-service";
import { registerTools } from "./tools";
import { registerChannel } from "./channel";
import { createState } from "./state";
import { createContacts } from "./contacts";
import { resolveConfig, type AgentLinkConfig } from "./types";

export default function register(api: PluginApi) {
  const config = resolveConfig(api.config);
  const contacts = createContacts(config.dataDir);
  const state = createState(config.dataDir);
  const mqttService = createMqttService(config, state, contacts, api);

  // Background MQTT connection — starts on gateway boot, stops on shutdown
  api.registerService({
    id: "agentlink-mqtt",
    start: () => mqttService.start(),
    stop: () => mqttService.stop(),
  });

  // Capability rescan on startup — warn if new OC tools could map to capabilities
  rescanCapabilities(api, config);

  // Agent tools — the LLM calls these to coordinate
  registerTools(api, config, mqttService, state, contacts);

  // Optional channel registration — makes AgentLink appear as a channel in OC
  registerChannel(api, config, mqttService);

  // CLI: `openclaw agentlink capabilities` — interactive rescan + update
  api.registerCli(({ program }) => {
    const cmd = program.command("agentlink").description("AgentLink agent coordination");
    cmd.command("capabilities").description("Rescan OC tools and update capabilities").action(async () => {
      await rescanCapabilitiesInteractive(api, config);
    });
    cmd.command("status").description("Show AgentLink connection and group status").action(() => {
      console.log(`Agent ID: ${config.agent.id}`);
      console.log(`Broker: ${config.brokerUrl}`);
      console.log(`Connected: ${mqttService.getClient().isConnected()}`);
      console.log(`Active groups: ${state.getActiveGroups().length}`);
      console.log(`Capabilities: ${config.agent.capabilities.map(c => c.name).join(", ") || "none"}`);
    });
  }, { commands: ["agentlink"] });
}

export const id = "agentlink";
export const name = "AgentLink";
```

### Capability Rescan on Restart

On every gateway boot, the plugin compares the agent's configured capabilities against OC's current tool registry:

```typescript
function rescanCapabilities(api: PluginApi, config: AgentLinkConfig) {
  // Get all registered OC tools
  const availableTools = api.getRegisteredTools?.() ?? [];
  const configuredToolIds = new Set(config.agent.capabilities.map(c => c.tool));

  // Find tools that aren't mapped to any capability
  const unmapped = availableTools.filter(t => !configuredToolIds.has(t.id));
  if (unmapped.length > 0) {
    api.logger.info(
      `[AgentLink] ${unmapped.length} OC tool(s) not mapped to capabilities: ${unmapped.map(t => t.id).join(", ")}. ` +
      `Run 'openclaw agentlink capabilities' to update.`
    );
  }
}
```

`rescanCapabilitiesInteractive` (called by the CLI command) uses `configureInteractive()` to walk the user through selecting which new tools to expose as capabilities and writes the result back to the OC config.

### Shared Context Object

Rather than passing 5+ arguments to every function, the plugin constructs a shared context:

```typescript
// Constructed once in index.ts, passed to all modules
interface AgentLinkContext {
  config: AgentLinkConfig;
  state: StateManager;
  contacts: ContactsManager;
  mqtt: MqttService;
  api: PluginApi;
  log: (msg: string) => void; // debug-mode-aware logger
}
```

The `log` function checks `config.output_mode`:
- `"debug"`: logs `[AgentLink] <msg>` via `api.logger.info`
- `"user"`: silent (no coordination noise)

---

## 4. Types (types.ts)

### Config Types

```typescript
export interface AgentLinkConfig {
  brokerUrl: string;
  brokerUsername?: string;
  brokerPassword?: string;
  agent: {
    id: string;
    description?: string;
    capabilities: Capability[];
  };
  outputMode: "user" | "debug";
  jobTimeoutMs: number;
  dataDir: string;
}

export interface Capability {
  name: string;
  tool: string;
  description?: string;
  input_hint?: string;
}

export function resolveConfig(rawConfig: Record<string, unknown>): AgentLinkConfig {
  const cfg = rawConfig.plugins?.entries?.agentlink?.config;
  return {
    brokerUrl: cfg.brokerUrl ?? "mqtts://broker.agentlink.dev:8883",
    brokerUsername: cfg.brokerUsername,
    brokerPassword: cfg.brokerPassword,
    agent: {
      id: cfg.agent.id,
      description: cfg.agent.description,
      capabilities: cfg.agent.capabilities ?? [],
    },
    outputMode: cfg.output_mode ?? "user",
    jobTimeoutMs: cfg.job_timeout_ms ?? 60_000,
    dataDir: cfg.data_dir ?? path.join(os.homedir(), ".agentlink"),
  };
}
```

### Message Envelope

```typescript
export interface MessageEnvelope {
  v: 1;
  id: string;           // UUID — unique per message
  group_id: string;      // UUID — which group/coordination context
  intent_id: string;     // UUID — which top-level intent (stable across a coordination session)
  from: string;          // agent_id of sender
  to: "group" | string;  // "group" for broadcast, or specific agent_id
  type: MessageType;
  correlation_id?: string;  // links job_request to job_response
  coordination?: CoordinationHeader;  // only on first message of a session
  payload: MessagePayload;
  ts: string;            // ISO 8601
}

export type MessageType = "chat" | "job_request" | "job_response" | "join" | "leave";

export interface CoordinationHeader {
  driver_agent_id: string;
  goal: string;
  done_when: string;
}

export interface MessagePayload {
  text?: string;
  capability?: string;
  status?: JobStatus;
  result?: string;
  proposal?: ProposalPayload;
  // Extensible: unknown fields are ignored
  [key: string]: unknown;
}

export interface ProposalPayload {
  summary: string;        // "Olive Garden, 7pm, 2 people"
  requires_approval: boolean;
}

export type JobStatus = "requested" | "completed" | "failed" | "awaiting_approval";
```

### Agent Status (retained message)

```typescript
export interface AgentStatus {
  agent_id: string;
  owner: string;
  status: "online" | "offline";
  capabilities: CapabilityAdvertisement[];
  description?: string;
  ts: string;
}

export interface CapabilityAdvertisement {
  name: string;
  description: string;
  input_hint: string;
}
```

### Invite Message

```typescript
export interface InviteMessage {
  type: "invite";
  group_id: string;
  from: string;
  goal: string;
  done_when: string;
  ts: string;
}

export interface InviteCodePayload {
  group_id: string;
  from: string;
  goal: string;
  created_at: string;
}
```

### Helper: Message Construction

```typescript
import { v4 as uuid } from "uuid";

export function createEnvelope(
  from: string,
  overrides: Partial<MessageEnvelope> & Pick<MessageEnvelope, "group_id" | "to" | "type" | "payload">
): MessageEnvelope {
  return {
    v: 1,
    id: uuid(),
    intent_id: overrides.intent_id ?? uuid(),
    from,
    ts: new Date().toISOString(),
    ...overrides,
  };
}
```

### Topic Helpers

```typescript
export const TOPICS = {
  inbox: (agentId: string) =>
    `agentlink/agents/${agentId}/inbox`,
  groupMessages: (groupId: string, agentId: string) =>
    `agentlink/${groupId}/messages/${agentId}`,
  groupMessagesWildcard: (groupId: string) =>
    `agentlink/${groupId}/messages/+`,
  groupStatus: (groupId: string, agentId: string) =>
    `agentlink/${groupId}/status/${agentId}`,
  groupStatusWildcard: (groupId: string) =>
    `agentlink/${groupId}/status/+`,
  groupSystem: (groupId: string) =>
    `agentlink/${groupId}/system`,
  groupAll: (groupId: string) =>
    `agentlink/${groupId}/#`,
  inviteCode: (code: string) =>
    `agentlink/invites/${code}`,
} as const;
```

---

## 5. MQTT Client (mqtt-client.ts)

Thin wrapper around `mqtt.js`. Handles connection, reconnection, subscribe/publish, and message parsing.

### Interface

```typescript
export interface MqttClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(topic: string): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
  publish(topic: string, payload: string | Buffer, options?: PublishOptions): Promise<void>;
  onMessage(handler: (topic: string, payload: Buffer) => void): void;
  isConnected(): boolean;
}

export interface PublishOptions {
  retain?: boolean;
  qos?: 0 | 1 | 2;
}
```

### Implementation Notes

```typescript
import mqtt from "mqtt";

export function createMqttClient(config: AgentLinkConfig, logger: Logger): MqttClient {
  let client: mqtt.MqttClient | null = null;
  const messageHandlers: Array<(topic: string, payload: Buffer) => void> = [];

  return {
    async connect() {
      client = mqtt.connect(config.brokerUrl, {
        username: config.brokerUsername,
        password: config.brokerPassword,
        clientId: `agentlink-${config.agent.id}-${Date.now()}`,
        clean: true,
        keepalive: 30,
        reconnectPeriod: 5000,
        connectTimeout: 10_000,
      });

      return new Promise((resolve, reject) => {
        client!.on("connect", () => {
          logger.info(`[AgentLink] Connected to broker: ${config.brokerUrl}`);
          resolve();
        });
        client!.on("error", (err) => {
          logger.error(`[AgentLink] MQTT error: ${err.message}`);
          reject(err);
        });
        client!.on("message", (topic, payload) => {
          for (const handler of messageHandlers) {
            handler(topic, payload);
          }
        });
        client!.on("reconnect", () => {
          logger.info("[AgentLink] Reconnecting to broker...");
        });
        client!.on("offline", () => {
          logger.warn("[AgentLink] Broker connection lost");
        });
      });
    },

    async disconnect() {
      if (client) {
        await new Promise<void>((resolve) => client!.end(false, {}, resolve));
        client = null;
      }
    },

    async subscribe(topic) {
      if (!client) throw new Error("MQTT not connected");
      return new Promise((resolve, reject) => {
        client!.subscribe(topic, { qos: 1 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    async unsubscribe(topic) {
      if (!client) throw new Error("MQTT not connected");
      return new Promise((resolve, reject) => {
        client!.unsubscribe(topic, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    async publish(topic, payload, options = {}) {
      if (!client) throw new Error("MQTT not connected");
      return new Promise((resolve, reject) => {
        client!.publish(
          topic,
          payload,
          { qos: options.qos ?? 1, retain: options.retain ?? false },
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    },

    onMessage(handler) {
      messageHandlers.push(handler);
    },

    isConnected() {
      return client?.connected ?? false;
    },
  };
}
```

### Key Design Decisions

- **QoS 1 default**: At-least-once delivery. Acceptable for coordination messages. QoS 2 (exactly-once) is too slow for V1.
- **clean: true**: No persistent sessions on the broker. Retained messages handle the "last known state" case. Full session persistence is V2.
- **clientId includes timestamp**: Prevents "client already connected" errors when restarting quickly.
- **reconnectPeriod: 5000ms**: Auto-reconnect every 5s. mqtt.js handles this natively.

---

## 6. Background Service (mqtt-service.ts)

The long-running service that keeps the MQTT connection alive and routes inbound messages.

### Interface

```typescript
export interface MqttService {
  start(): Promise<void>;
  stop(): Promise<void>;
  publish(topic: string, payload: string, options?: PublishOptions): Promise<void>;
  publishEnvelope(topic: string, envelope: MessageEnvelope): Promise<void>;
  subscribeGroup(groupId: string): Promise<void>;
  unsubscribeGroup(groupId: string): Promise<void>;
  getClient(): MqttClient;
}
```

### Implementation Outline

```typescript
export function createMqttService(
  config: AgentLinkConfig,
  state: StateManager,
  contacts: ContactsManager,
  api: PluginApi
): MqttService {
  const client = createMqttClient(config, api.logger);
  const router = createMessageRouter(config, state, contacts, api);

  return {
    async start() {
      await client.connect();

      // Always subscribe to personal inbox
      await client.subscribe(TOPICS.inbox(config.agent.id));

      // Resubscribe to active groups from persisted state
      const activeGroups = state.getActiveGroups();
      for (const groupId of activeGroups) {
        await client.subscribe(TOPICS.groupAll(groupId));
      }

      // Route all inbound messages
      client.onMessage((topic, payload) => {
        try {
          const parsed = JSON.parse(payload.toString());
          router.handle(topic, parsed);
        } catch (err) {
          api.logger.warn(`[AgentLink] Malformed message on ${topic}: ${err}`);
        }
      });

      // Check for timed-out jobs from before restart
      state.checkTimeouts(config.jobTimeoutMs);
    },

    async stop() {
      // Publish offline status for all active groups
      for (const groupId of state.getActiveGroups()) {
        const statusTopic = TOPICS.groupStatus(groupId, config.agent.id);
        await client.publish(statusTopic, JSON.stringify({
          agent_id: config.agent.id,
          status: "offline",
          ts: new Date().toISOString(),
        }), { retain: true });
      }
      await client.disconnect();
    },

    async publish(topic, payload, options) {
      await client.publish(topic, payload, options);
    },

    async publishEnvelope(topic, envelope) {
      await client.publish(topic, JSON.stringify(envelope), { qos: 1 });
    },

    async subscribeGroup(groupId) {
      await client.subscribe(TOPICS.groupAll(groupId));
    },

    async unsubscribeGroup(groupId) {
      await client.unsubscribe(TOPICS.groupAll(groupId));
    },

    getClient() {
      return client;
    },
  };
}
```

### Message Router (internal to mqtt-service.ts)

```typescript
function createMessageRouter(config, state, contacts, api) {
  return {
    handle(topic: string, msg: unknown) {
      // 1. Determine topic type from path structure
      if (topic === TOPICS.inbox(config.agent.id)) {
        handleInbox(msg);
      } else if (topic.match(/^agentlink\/[^/]+\/messages\/.+$/)) {
        handleGroupMessage(msg);
      } else if (topic.match(/^agentlink\/[^/]+\/status\/.+$/)) {
        handleStatusUpdate(msg);
      } else if (topic.match(/^agentlink\/[^/]+\/system$/)) {
        handleSystemEvent(msg);
      }
    },
  };
}
```

#### Inbox Handler (invites + direct jobs)

```typescript
function handleInbox(msg: unknown) {
  // Validate envelope shape
  if (isInviteMessage(msg)) {
    // -> Notify owner via OC channel for approval
    // -> On approval: subscribe to group, publish join + status
    // -> Save contact if first-time (trust-on-first-use)
  } else if (isJobRequest(msg)) {
    // -> Direct job (not group-based): validate capability, run tool, respond
  }
}
```

#### Group Message Handler

```typescript
function handleGroupMessage(msg: MessageEnvelope) {
  // Ignore messages from self
  if (msg.from === config.agent.id) return;

  // If this is a job_request targeted at us:
  if (msg.type === "job_request" && (msg.to === config.agent.id || matchesCapability(msg))) {
    handleJobRequest(msg);
    return;
  }

  // If this is a job_response for a pending job we sent:
  if (msg.type === "job_response" && state.hasPendingJob(msg.correlation_id)) {
    handleJobResponse(msg);
    return;
  }

  // Group coordination message — wake the agent with context
  wakeAgent(msg);
}
```

#### Wake Agent

```typescript
function wakeAgent(msg: MessageEnvelope) {
  // Use api.sendMessage or equivalent OC mechanism to inject
  // the message into the agent's context so the LLM can reason about it
  // and decide what to do next (send another message, submit a job, complete, etc.)
  //
  // The exact OC API for this depends on how registerChannel/registerService
  // feeds messages into the agent loop. See channel.ts for the channel-based path.
}
```

---

## 7. Contacts Store (contacts.ts)

### Interface

```typescript
export interface ContactsManager {
  resolve(nameOrId: string): string | null;  // returns agent_id or null
  add(name: string, agentId: string): void;
  remove(name: string): void;
  has(name: string): boolean;
  getAll(): Record<string, ContactEntry>;
  getNameByAgentId(agentId: string): string | null;
}

export interface ContactEntry {
  agent_id: string;
  added: string;  // ISO date
}
```

### Implementation

```typescript
import fs from "fs";
import path from "path";

export function createContacts(dataDir: string): ContactsManager {
  const filePath = path.join(dataDir, "contacts.json");
  let contacts: Record<string, ContactEntry> = {};

  // Load on init
  if (fs.existsSync(filePath)) {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    contacts = raw.contacts ?? {};
  }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ contacts }, null, 2));
  }

  return {
    resolve(nameOrId) {
      // Check by name first
      if (contacts[nameOrId]) return contacts[nameOrId].agent_id;
      // Check if input is already an agent_id
      for (const entry of Object.values(contacts)) {
        if (entry.agent_id === nameOrId) return nameOrId;
      }
      return null;
    },

    add(name, agentId) {
      contacts[name] = { agent_id: agentId, added: new Date().toISOString().split("T")[0] };
      save();
    },

    remove(name) {
      delete contacts[name];
      save();
    },

    has(name) {
      return name in contacts;
    },

    getAll() {
      return { ...contacts };
    },

    getNameByAgentId(agentId) {
      for (const [name, entry] of Object.entries(contacts)) {
        if (entry.agent_id === agentId) return name;
      }
      return null;
    },
  };
}
```

### Trust-on-First-Use Behavior

When an invite is received from an unknown agent:

1. Extract `from` field (agent_id) and `owner` field from the status message
2. Notify the user via their primary OC channel:
   > "Agent `rupul-macbook` (Rupul) wants to coordinate: 'Plan dinner Saturday'. Allow?"
3. If user approves:
   - `contacts.add("Rupul", "rupul-macbook")`
   - Proceed with group join
4. If user denies:
   - Publish nothing. Ignore the invite.

---

## 8. Local State (state.ts)

### Interface

```typescript
export interface StateManager {
  // Groups
  addGroup(group: GroupState): void;
  getGroup(groupId: string): GroupState | null;
  removeGroup(groupId: string): void;
  getActiveGroups(): string[];  // returns group IDs
  updateGroup(groupId: string, updates: Partial<GroupState>): void;
  incrementIdleTurns(groupId: string): number;  // returns new count
  resetIdleTurns(groupId: string): void;

  // Jobs
  addJob(job: PendingJob): void;
  getJob(correlationId: string): PendingJob | null;
  completeJob(correlationId: string, status: JobStatus, result?: string): void;
  removeJob(correlationId: string): void;
  hasPendingJob(correlationId: string): boolean;
  getJobsForGroup(groupId: string): PendingJob[];
  checkTimeouts(timeoutMs: number): TimedOutJob[];
}

export interface GroupState {
  group_id: string;
  driver: string;        // agent_id of driver
  goal: string;
  done_when: string;
  intent_id: string;
  participants: string[];  // agent_ids
  status: "active" | "closing";
  idle_turns: number;
  created_at: string;
}

export interface PendingJob {
  correlation_id: string;
  group_id: string;
  target: string;         // agent_id
  capability: string;
  status: JobStatus;
  sent_at: string;        // ISO 8601
  text?: string;
}

export interface TimedOutJob extends PendingJob {
  timed_out: true;
}
```

### Implementation

```typescript
export function createState(dataDir: string): StateManager {
  const filePath = path.join(dataDir, "state.json");
  let data: { groups: Record<string, GroupState>; pending_jobs: Record<string, PendingJob> } = {
    groups: {},
    pending_jobs: {},
  };

  // Load on init
  if (fs.existsSync(filePath)) {
    data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  return {
    addGroup(group) {
      data.groups[group.group_id] = group;
      save();
    },

    getGroup(groupId) {
      return data.groups[groupId] ?? null;
    },

    removeGroup(groupId) {
      delete data.groups[groupId];
      // Also clean up any pending jobs for this group
      for (const [id, job] of Object.entries(data.pending_jobs)) {
        if (job.group_id === groupId) delete data.pending_jobs[id];
      }
      save();
    },

    getActiveGroups() {
      return Object.keys(data.groups).filter(
        (id) => data.groups[id].status === "active"
      );
    },

    updateGroup(groupId, updates) {
      if (data.groups[groupId]) {
        Object.assign(data.groups[groupId], updates);
        save();
      }
    },

    incrementIdleTurns(groupId) {
      const group = data.groups[groupId];
      if (!group) return 0;
      group.idle_turns++;
      save();
      return group.idle_turns;
    },

    resetIdleTurns(groupId) {
      if (data.groups[groupId]) {
        data.groups[groupId].idle_turns = 0;
        save();
      }
    },

    addJob(job) {
      data.pending_jobs[job.correlation_id] = job;
      save();
    },

    getJob(correlationId) {
      return data.pending_jobs[correlationId] ?? null;
    },

    completeJob(correlationId, status, result) {
      const job = data.pending_jobs[correlationId];
      if (job) {
        job.status = status;
        save();
      }
    },

    removeJob(correlationId) {
      delete data.pending_jobs[correlationId];
      save();
    },

    hasPendingJob(correlationId) {
      const job = data.pending_jobs[correlationId];
      return !!job && job.status === "requested";
    },

    getJobsForGroup(groupId) {
      return Object.values(data.pending_jobs).filter((j) => j.group_id === groupId);
    },

    checkTimeouts(timeoutMs) {
      const now = Date.now();
      const timedOut: TimedOutJob[] = [];
      for (const [id, job] of Object.entries(data.pending_jobs)) {
        if (job.status === "requested") {
          const elapsed = now - new Date(job.sent_at).getTime();
          if (elapsed > timeoutMs) {
            job.status = "failed";
            timedOut.push({ ...job, timed_out: true });
          }
        }
      }
      if (timedOut.length > 0) save();
      return timedOut;
    },
  };
}
```

### Disk Write Strategy

- Synchronous `fs.writeFileSync` for V1. State file is small (<10KB typically).
- Write on every mutation. No batching. Ensures crash resilience.
- If this becomes a performance issue (unlikely for V1), switch to debounced writes.

---

## 9. Invite System (invite.ts)

### Interface

```typescript
export interface InviteManager {
  createInviteCode(groupId: string, from: string, goal: string): Promise<InviteCodeResult>;
  resolveInviteCode(code: string): Promise<InviteCodePayload | null>;
  sendDirectInvite(targetAgentId: string, groupId: string, goal: string, doneWhen: string): Promise<void>;
}

export interface InviteCodeResult {
  code: string;
  shareableMessage: string;  // ready-to-send text with install instructions
}
```

### Implementation

```typescript
import { v4 as uuid } from "uuid";

export function createInviteManager(
  config: AgentLinkConfig,
  mqtt: MqttService
): InviteManager {
  return {
    async createInviteCode(groupId, from, goal) {
      // Generate 6-char alphanumeric code
      const code = uuid().replace(/-/g, "").substring(0, 6).toUpperCase();

      const payload: InviteCodePayload = {
        group_id: groupId,
        from,
        goal,
        created_at: new Date().toISOString(),
      };

      // Publish as retained message so anyone can resolve it later
      await mqtt.publish(
        TOPICS.inviteCode(code),
        JSON.stringify(payload),
        { retain: true, qos: 1 }
      );

      const shareableMessage = [
        `Join my agent coordination: ${code}`,
        `1. Install AgentLink: openclaw plugins install @agentlinkdev/openclaw`,
        `2. Tell your agent: "Join AgentLink group ${code}"`,
      ].join("\n");

      return { code, shareableMessage };
    },

    async resolveInviteCode(code) {
      // Subscribe to the invite topic, wait for the retained message
      return new Promise((resolve) => {
        const topic = TOPICS.inviteCode(code);
        let resolved = false;

        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }, 5000);

        const handler = (msgTopic: string, payload: Buffer) => {
          if (msgTopic === topic && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            try {
              resolve(JSON.parse(payload.toString()));
            } catch {
              resolve(null);
            }
          }
        };

        mqtt.getClient().onMessage(handler);
        mqtt.getClient().subscribe(topic).catch(() => resolve(null));
      });
    },

    async sendDirectInvite(targetAgentId, groupId, goal, doneWhen) {
      const invite: InviteMessage = {
        type: "invite",
        group_id: groupId,
        from: config.agent.id,
        goal,
        done_when: doneWhen,
        ts: new Date().toISOString(),
      };

      await mqtt.publish(
        TOPICS.inbox(targetAgentId),
        JSON.stringify(invite),
        { qos: 1 }
      );
    },
  };
}
```

### Invite Code Resolution Edge Cases

- **Code not found**: `resolveInviteCode` returns `null` after 5s timeout. Agent tells user "Invalid invite code."
- **Code reuse**: Invite codes are not invalidated. Anyone with the code can join. This matches the WhatsApp trust model.
- **Stale codes**: Codes for closed groups will resolve to a group_id that has no active subscriptions. The joining agent will subscribe but receive no messages. The agent should detect this (no status messages received within 10s) and report "Group no longer active."

---

## 10. Routing (routing.ts)

### Interface

```typescript
export interface Router {
  resolveTarget(msg: MessageEnvelope, groupParticipants: AgentStatus[]): string[];
}
```

### Implementation

```typescript
export function createRouter(): Router {
  return {
    resolveTarget(msg, groupParticipants) {
      // Rule 1: Explicit target — route directly
      if (msg.to !== "group") {
        return [msg.to];
      }

      // Rule 2: Capability match — filter by capability
      if (msg.payload.capability) {
        const capName = msg.payload.capability;
        return groupParticipants
          .filter((p) => p.agent_id !== msg.from) // exclude sender
          .filter((p) =>
            p.capabilities.some((c) => c.name === capName) // exact match
          )
          .map((p) => p.agent_id);
      }

      // Rule 3: No capability — broadcast to all except sender
      return groupParticipants
        .filter((p) => p.agent_id !== msg.from)
        .map((p) => p.agent_id);
    },
  };
}
```

### Routing is Receiver-Side

Routing happens on the **receiving** side, not the sending side. Every agent in a group receives every message on `agentlink/<group-uuid>/messages/+`. The router determines whether _this_ agent should process the message:

```typescript
function shouldProcess(msg: MessageEnvelope, myAgentId: string, myCapabilities: Capability[]): boolean {
  // Always process if addressed to us directly
  if (msg.to === myAgentId) return true;

  // If broadcast with capability filter: only process if we have the capability
  if (msg.to === "group" && msg.payload.capability) {
    return myCapabilities.some((c) => c.name === msg.payload.capability);
  }

  // Broadcast without capability: process (group coordination)
  if (msg.to === "group") return true;

  // Addressed to someone else
  return false;
}
```

---

## 11. Job Lifecycle (jobs.ts)

### Interface

```typescript
export interface JobManager {
  // Requester side
  submitJob(params: SubmitJobParams): Promise<string>;  // returns correlation_id
  handleJobResponse(msg: MessageEnvelope): void;

  // Receiver side
  handleJobRequest(msg: MessageEnvelope): Promise<void>;
}

export interface SubmitJobParams {
  groupId: string;
  intentId: string;
  targetAgentId?: string;   // explicit target (skip capability routing)
  capability: string;
  text: string;             // NL description of what to do
}
```

### Requester Side

```typescript
async submitJob(params) {
  const correlationId = uuid();
  const envelope = createEnvelope(config.agent.id, {
    group_id: params.groupId,
    intent_id: params.intentId,
    to: params.targetAgentId ?? "group",
    type: "job_request",
    correlation_id: correlationId,
    payload: {
      text: params.text,
      capability: params.capability,
    },
  });

  // Track locally
  state.addJob({
    correlation_id: correlationId,
    group_id: params.groupId,
    target: params.targetAgentId ?? "group",
    capability: params.capability,
    status: "requested",
    sent_at: envelope.ts,
    text: params.text,
  });

  // Publish to group messages topic (all agents receive, routing filters)
  await mqtt.publishEnvelope(
    TOPICS.groupMessages(params.groupId, config.agent.id),
    envelope
  );

  // Start timeout timer
  setTimeout(() => {
    if (state.hasPendingJob(correlationId)) {
      state.completeJob(correlationId, "failed");
      log(`Job ${correlationId} timed out (${params.capability})`);
      // Wake agent so it can decide what to do about the failure
      wakeAgentWithJobTimeout(correlationId, params);
    }
  }, config.jobTimeoutMs);

  return correlationId;
}
```

### Receiver Side

```typescript
async handleJobRequest(msg) {
  const capability = msg.payload.capability;
  if (!capability) return;

  // Find matching local capability
  const cap = config.agent.capabilities.find((c) => c.name === capability);
  if (!cap) {
    // We don't have this capability — publish failure response
    await publishJobResponse(msg, "failed", `Capability '${capability}' not available`);
    return;
  }

  log(`Running local tool: ${cap.tool} for capability: ${capability}`);

  // Check if this capability requires owner approval
  // (Determined by the tool's configuration in OC, not by AgentLink)
  // For V1: all job requests are auto-executed. Approval gates are added
  // by configuring the underlying OC tool with approval requirements.

  try {
    // Execute the local OC tool
    // api.executeTool is the OC Plugin SDK method to run a tool programmatically
    const result = await api.executeTool(cap.tool, {
      input: msg.payload.text,
      // Pass context so the tool's LLM can reason about the request
    });

    await publishJobResponse(msg, "completed", result);
  } catch (err) {
    await publishJobResponse(msg, "failed", `Tool execution error: ${err.message}`);
  }
}

async function publishJobResponse(
  request: MessageEnvelope,
  status: JobStatus,
  result: string
) {
  const response = createEnvelope(config.agent.id, {
    group_id: request.group_id,
    intent_id: request.intent_id,
    to: request.from,  // respond to requester
    type: "job_response",
    correlation_id: request.correlation_id,
    payload: {
      status,
      result,
      capability: request.payload.capability,
    },
  });

  await mqtt.publishEnvelope(
    TOPICS.groupMessages(request.group_id, config.agent.id),
    response
  );
}
```

### Job Lifecycle State Machine

```
             submitJob()
                |
                v
          [requested] --------timeout-------> [failed]
                |                                 ^
                v                                 |
        handleJobResponse()                       |
           /        \                             |
          v          v                            |
    [completed]   [failed] <---tool error---------+
                     |
                     v
              (driver decides:
               retry / escalate / skip)
```

Note: `awaiting_approval` is not a state the job system manages directly. If a tool requires approval, the OC tool itself pauses (via OC's built-in HITL). The job stays in `requested` state from AgentLink's perspective until the tool returns.

---

## 12. Agent Tools (tools.ts)

These are the tools the LLM calls. Registered via `api.registerTool()` (or the OC plugin SDK equivalent for agent tools).

### Tool: agentlink_coordinate

**Purpose:** Primary entry point. Human says "Plan dinner with Sara" → agent calls this tool.

```typescript
{
  name: "agentlink_coordinate",
  description: "Start coordinating with other people's agents. Use this when the user wants to do something that involves other people.",
  parameters: {
    type: "object",
    required: ["goal", "participants"],
    properties: {
      goal: {
        type: "string",
        description: "What the user wants to accomplish (e.g. 'Plan dinner with Sara this Saturday')"
      },
      done_when: {
        type: "string",
        description: "How to know when this is complete (e.g. 'restaurant selected and reservation confirmed')"
      },
      participants: {
        type: "array",
        items: { type: "string" },
        description: "Names or agent IDs of people to coordinate with"
      }
    }
  }
}
```

**Implementation:**

```typescript
async function executeCoordinate({ goal, done_when, participants }) {
  const groupId = uuid();
  const intentId = uuid();

  // Resolve participant names to agent_ids
  const resolved: Array<{ name: string; agentId: string | null }> = participants.map((p) => ({
    name: p,
    agentId: contacts.resolve(p),
  }));

  const unresolved = resolved.filter((r) => !r.agentId);
  if (unresolved.length > 0) {
    // Return error to LLM — it should ask the user for the agent ID
    return {
      error: `Unknown contacts: ${unresolved.map((u) => u.name).join(", ")}. ` +
             `Ask the user for their agent ID, or use agentlink_invite_agent with an agent_id.`
    };
  }

  const participantIds = resolved.map((r) => r.agentId!);

  // Create group in local state
  state.addGroup({
    group_id: groupId,
    driver: config.agent.id,
    goal,
    done_when: done_when ?? `${goal} — completed to user's satisfaction`,
    intent_id: intentId,
    participants: participantIds,
    status: "active",
    idle_turns: 0,
    created_at: new Date().toISOString(),
  });

  // Subscribe to group topics
  await mqtt.subscribeGroup(groupId);

  // Publish own status (retained)
  await publishStatus(groupId);

  // Send invites to all participants
  for (const pid of participantIds) {
    await invites.sendDirectInvite(pid, groupId, goal, done_when);
    log(`Invite sent to ${contacts.getNameByAgentId(pid) ?? pid}`);
  }

  return {
    group_id: groupId,
    intent_id: intentId,
    participants: participantIds,
    status: "invites_sent",
    message: `Coordination started. Waiting for ${participantIds.length} agent(s) to join.`,
  };
}
```

### Tool: agentlink_submit_job

**Purpose:** Send a specific task to another agent by capability.

```typescript
{
  name: "agentlink_submit_job",
  description: "Send a specific task to another agent. Use this to request actions like checking a calendar, searching for restaurants, etc.",
  parameters: {
    type: "object",
    required: ["group_id", "capability", "text"],
    properties: {
      group_id: {
        type: "string",
        description: "The active group/coordination ID"
      },
      capability: {
        type: "string",
        description: "The capability to request (e.g. 'check_calendar', 'suggest_restaurants')"
      },
      target_agent: {
        type: "string",
        description: "Specific agent ID to target (optional — if omitted, routes by capability)"
      },
      text: {
        type: "string",
        description: "Natural language description of what you need (e.g. 'Check Saturday evening availability 6-10pm')"
      }
    }
  }
}
```

**Implementation:**

```typescript
async function executeSubmitJob({ group_id, capability, target_agent, text }) {
  const group = state.getGroup(group_id);
  if (!group) return { error: "Group not found or already closed" };

  const correlationId = await jobs.submitJob({
    groupId: group_id,
    intentId: group.intent_id,
    targetAgentId: target_agent,
    capability,
    text,
  });

  state.resetIdleTurns(group_id); // job_request resets idle counter

  return {
    correlation_id: correlationId,
    status: "requested",
    message: `Job sent: ${capability}. Waiting for response (timeout: ${config.jobTimeoutMs / 1000}s).`,
  };
}
```

### Tool: agentlink_invite_agent

**Purpose:** Invite a specific agent to an existing group.

```typescript
{
  name: "agentlink_invite_agent",
  description: "Invite someone to join a coordination group. Use when adding new participants mid-coordination.",
  parameters: {
    type: "object",
    required: ["group_id", "name_or_agent_id"],
    properties: {
      group_id: { type: "string" },
      name_or_agent_id: {
        type: "string",
        description: "Contact name (e.g. 'Sara') or agent ID (e.g. 'sara-macbook')"
      }
    }
  }
}
```

### Tool: agentlink_join_group

**Purpose:** Join a group via invite code. For when someone shares a code out-of-band.

```typescript
{
  name: "agentlink_join_group",
  description: "Join a coordination group using an invite code that was shared with you.",
  parameters: {
    type: "object",
    required: ["invite_code"],
    properties: {
      invite_code: {
        type: "string",
        description: "The 6-character invite code (e.g. 'AB3X7K')"
      }
    }
  }
}
```

**Implementation:**

```typescript
async function executeJoinGroup({ invite_code }) {
  const invite = await invites.resolveInviteCode(invite_code);
  if (!invite) return { error: "Invalid or expired invite code" };

  const groupId = invite.group_id;

  // Subscribe to group
  await mqtt.subscribeGroup(groupId);

  // Add to local state
  state.addGroup({
    group_id: groupId,
    driver: invite.from,  // The inviter is the driver
    goal: invite.goal,
    done_when: "",  // Will be received in coordination header
    intent_id: "",  // Will be received in first coordination message
    participants: [invite.from],
    status: "active",
    idle_turns: 0,
    created_at: new Date().toISOString(),
  });

  // Publish status (retained)
  await publishStatus(groupId);

  // Publish join event
  const joinMsg = createEnvelope(config.agent.id, {
    group_id: groupId,
    to: "group",
    type: "join",
    payload: { text: `${config.agent.id} joined the group` },
  });
  await mqtt.publishEnvelope(TOPICS.groupSystem(groupId), joinMsg);

  // Trust-on-first-use: save contact if new
  if (!contacts.resolve(invite.from)) {
    // Will be confirmed by user via OC channel
    // For now, auto-save (V1 simplification)
    contacts.add(invite.from, invite.from);
  }

  return {
    group_id: groupId,
    driver: invite.from,
    goal: invite.goal,
    status: "joined",
  };
}
```

### Tool: agentlink_complete

**Purpose:** Driver declares coordination done. Group auto-closes.

```typescript
{
  name: "agentlink_complete",
  description: "Declare that the coordination is complete. Only call this when the goal has been achieved or explicitly abandoned.",
  parameters: {
    type: "object",
    required: ["group_id", "summary"],
    properties: {
      group_id: { type: "string" },
      summary: {
        type: "string",
        description: "Final outcome summary (e.g. 'Dinner booked: Olive Garden, Saturday 7pm, 2 people')"
      },
      success: {
        type: "boolean",
        description: "Whether the goal was achieved",
        default: true
      }
    }
  }
}
```

**Implementation (group close sequence):**

```typescript
async function executeComplete({ group_id, summary, success = true }) {
  const group = state.getGroup(group_id);
  if (!group) return { error: "Group not found" };

  // Only the driver can complete
  if (group.driver !== config.agent.id) {
    return { error: "Only the driver agent can complete a coordination" };
  }

  // 1. Publish completion message to system topic
  const completionMsg = createEnvelope(config.agent.id, {
    group_id,
    to: "group",
    type: "leave",
    payload: {
      text: summary,
      status: success ? "completed" : "failed",
    },
  });
  await mqtt.publishEnvelope(TOPICS.groupSystem(group_id), completionMsg);

  // 2. Unsubscribe from group topics
  await mqtt.unsubscribeGroup(group_id);

  // 3. Delete retained status message (publish empty retained message)
  await mqtt.publish(
    TOPICS.groupStatus(group_id, config.agent.id),
    "",
    { retain: true }
  );

  // 4. Remove group from local state
  state.removeGroup(group_id);

  log(`Coordination complete: ${summary}`);

  return {
    group_id,
    status: success ? "completed" : "failed",
    summary,
  };
}
```

### Shared Helper: publishStatus

```typescript
async function publishStatus(groupId: string) {
  const status: AgentStatus = {
    agent_id: config.agent.id,
    owner: config.agent.description?.split("'s")[0] ?? config.agent.id, // "Rupul's personal agent" -> "Rupul"
    status: "online",
    capabilities: config.agent.capabilities.map((c) => ({
      name: c.name,
      description: c.description ?? c.name,
      input_hint: c.input_hint ?? "",
    })),
    description: config.agent.description,
    ts: new Date().toISOString(),
  };

  await mqtt.publish(
    TOPICS.groupStatus(groupId, config.agent.id),
    JSON.stringify(status),
    { retain: true }
  );
}
```

---

## 13. Channel Plugin (channel.ts)

The channel plugin is **optional** but provides the cleanest integration. It makes AgentLink messages appear as a channel in OC, which means the agent naturally processes them in its conversation loop.

```typescript
export function registerChannel(api: PluginApi, config: AgentLinkConfig, mqtt: MqttService) {
  const channelPlugin = {
    id: "agentlink",
    meta: {
      id: "agentlink",
      label: "AgentLink",
      selectionLabel: "AgentLink (Agent Coordination)",
      docsPath: "/plugins/agentlink",
      blurb: "Agent-to-agent coordination channel",
      aliases: ["al"],
    },
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    config: {
      listAccountIds: () => [config.agent.id],
      resolveAccount: () => ({
        accountId: config.agent.id,
        enabled: true,
        configured: true,
      }),
    },
    outbound: {
      deliveryMode: "direct",
      sendText: async ({ text, threadId, channelId }) => {
        // Agent wants to send a message back to an AgentLink group/agent
        // threadId = group_id, channelId = target agent or "group"
        if (!threadId) return { ok: false, error: "No group context" };

        const group = state.getGroup(threadId);
        if (!group) return { ok: false, error: "Group not found" };

        const envelope = createEnvelope(config.agent.id, {
          group_id: threadId,
          intent_id: group.intent_id,
          to: channelId ?? "group",
          type: "chat",
          payload: { text },
        });

        await mqtt.publishEnvelope(
          TOPICS.groupMessages(threadId, config.agent.id),
          envelope
        );

        // Track idle turns for anti-deadlock
        // (chat without proposal/job resets nothing — increment idle counter)
        if (group.driver === config.agent.id) {
          state.incrementIdleTurns(threadId);
        }

        return { ok: true };
      },
    },
  };

  api.registerChannel({ plugin: channelPlugin });
}
```

### Inbound Path (MQTT -> Agent)

When the MQTT service receives a message that should wake the agent, it injects the message through the channel:

```typescript
// In mqtt-service.ts, when a group message needs agent attention:
function wakeAgent(msg: MessageEnvelope) {
  // Construct the inbound message in OC's channel format
  // The exact method depends on OC's plugin SDK — likely:
  //   api.injectMessage({ channel: "agentlink", ... })
  // or the channel's inbound handler is called by the service

  const senderName = contacts.getNameByAgentId(msg.from) ?? msg.from;
  const groupInfo = state.getGroup(msg.group_id);

  // Build context string for the agent's LLM
  let context = `[AgentLink] Message from ${senderName}`;
  if (msg.type === "job_response") {
    const job = state.getJob(msg.correlation_id);
    context = `[AgentLink] Job result from ${senderName} (${msg.payload.capability}): ${msg.payload.result}`;
    if (msg.payload.status === "failed") {
      context = `[AgentLink] Job FAILED from ${senderName} (${msg.payload.capability}): ${msg.payload.result}`;
    }
  } else if (msg.type === "join") {
    context = `[AgentLink] ${senderName} joined the coordination for "${groupInfo?.goal}"`;
  }

  // Include group context so the LLM knows what's happening
  const systemContext = groupInfo
    ? `Active coordination: "${groupInfo.goal}". Done when: "${groupInfo.done_when}". ` +
      `You are the ${groupInfo.driver === config.agent.id ? "driver" : "participant"}.`
    : "";

  // Inject into OC agent loop
  // (Exact API TBD based on OC's registerChannel inbound mechanism)
}
```

---

## 14. Message Handling Pipeline

### Complete Inbound Flow

```
MQTT Broker
    |
    v
mqtt-client.ts: onMessage(topic, payload)
    |
    v
mqtt-service.ts: router.handle(topic, parsed)
    |
    +-- Is it my inbox topic?
    |     +-- Is it an invite? --> handleInvite() --> notify user, await approval
    |     +-- Is it a direct job? --> handleJobRequest() --> run tool, respond
    |
    +-- Is it a group message?
    |     +-- From me? --> ignore (echo)
    |     +-- shouldProcess()? (routing.ts)
    |           +-- job_request for me --> jobs.handleJobRequest()
    |           +-- job_response for my pending job --> jobs.handleJobResponse()
    |           +-- chat/coordination --> wakeAgent() --> channel injects into OC
    |
    +-- Is it a status update?
    |     +-- Cache participant capabilities (in-memory, for routing)
    |
    +-- Is it a system event?
          +-- join --> update participants list in state
          +-- leave/complete --> handle group close if driver closed it
```

### Complete Outbound Flow

```
Agent LLM decides to act
    |
    v
Calls an AgentLink tool (tools.ts)
    |
    +-- agentlink_coordinate --> create group, subscribe, send invites
    +-- agentlink_submit_job --> create envelope, publish to MQTT, track in state
    +-- agentlink_complete --> publish completion, unsubscribe, clean state
    +-- agentlink_invite_agent --> publish invite to target inbox
    +-- agentlink_join_group --> resolve code, subscribe, publish join
    |
    v
OR: Agent sends a chat message via channel.ts outbound
    |
    v
mqtt.publishEnvelope(topic, envelope)
    |
    v
MQTT Broker --> other agents
```

---

## 15. Anti-Deadlock Enforcement

### Where It Lives

The anti-deadlock protocol is enforced in two places:

1. **State tracking** (`state.ts`): `idle_turns` counter on each group
2. **Agent system prompt** (injected via `before_prompt_build` hook)

### Idle Turn Tracking

A "turn" is a `chat` message that does NOT contain:
- `type: "job_request"`
- `payload.proposal` field
- An approval request to an owner

**In the outbound path (channel.ts sendText):**

```typescript
// When the driver agent sends a chat message:
if (group.driver === config.agent.id) {
  const idleCount = state.incrementIdleTurns(group_id);
  if (idleCount >= 3) {
    // Inject warning into agent context on next turn
    // "You have had 3 turns of discussion without concrete action.
    //  You MUST now: submit a job, make a concrete proposal, or declare completion."
  }
}
```

**Reset conditions (in tools.ts):**

```typescript
// After agentlink_submit_job:
state.resetIdleTurns(group_id);

// In outbound, if payload contains .proposal:
state.resetIdleTurns(group_id);
```

### System Prompt Injection

```typescript
// In index.ts:
api.on("before_prompt_build", (event, ctx) => {
  const activeGroups = state.getActiveGroups();
  if (activeGroups.length === 0) return {};

  const driverGroups = activeGroups
    .map((id) => state.getGroup(id))
    .filter((g) => g?.driver === config.agent.id);

  if (driverGroups.length === 0) return {};

  let prompt = "\n\n## AgentLink Coordination Rules (MANDATORY)\n";
  prompt += "You are the DRIVER of active coordination(s). You MUST follow these rules:\n";
  prompt += "1. Issue direct jobs (agentlink_submit_job) instead of asking open-ended questions.\n";
  prompt += "2. Make concrete proposals with specifics (time, place, price), not vague suggestions.\n";
  prompt += "3. After 3 turns of discussion without a job, proposal, or completion, you MUST force progress.\n";
  prompt += "4. Declare completion (agentlink_complete) as soon as the done_when condition is met.\n";
  prompt += "5. Hub-and-spoke: you mediate all coordination. Participants respond to you, not each other.\n\n";

  for (const group of driverGroups) {
    prompt += `Active: "${group.goal}" | Done when: "${group.done_when}" | Idle turns: ${group.idle_turns}/3\n`;
    if (group.idle_turns >= 3) {
      prompt += `  WARNING: 3 idle turns reached. You MUST take concrete action NOW.\n`;
    }
  }

  return { appendSystemContext: prompt };
});
```

---

## 16. Error Handling

### Broker Disconnection

```typescript
// mqtt-client.ts handles reconnection automatically (mqtt.js reconnectPeriod: 5000)
// On reconnect:
client.on("reconnect", async () => {
  // Resubscribe to all active topics (mqtt.js does NOT auto-resubscribe with clean:true)
  await client.subscribe(TOPICS.inbox(config.agent.id));
  for (const groupId of state.getActiveGroups()) {
    await client.subscribe(TOPICS.groupAll(groupId));
  }
});
```

### Malformed Messages

```typescript
// In router.handle():
try {
  const parsed = JSON.parse(payload.toString());
  if (!parsed.v || !parsed.from || !parsed.type) {
    logger.warn(`[AgentLink] Malformed envelope: missing required fields`);
    return; // Drop silently
  }
  if (parsed.v !== 1) {
    logger.warn(`[AgentLink] Unknown protocol version: ${parsed.v}`);
    return; // Drop — forward compatibility means we ignore unknown versions
  }
  // ... route normally
} catch {
  logger.warn(`[AgentLink] Non-JSON message on ${topic}`);
  // Drop silently
}
```

### Agent Offline (job target unavailable)

The job timeout handles this. If the target agent doesn't respond within `job_timeout_ms`, the job is marked `failed` and the driver agent is woken to decide next steps (retry, skip, or escalate to owner).

### Group Stale Detection

If a participant's status message has `status: "offline"`, the driver can:
1. Skip jobs that would target them
2. Continue coordination with remaining participants
3. Inform the owner if a critical participant is offline

---

## 17. Testing Strategy

### Unit Tests

| File | Tests |
|------|-------|
| `contacts.test.ts` | Add, resolve by name, resolve by agent_id, remove, trust-on-first-use flow |
| `state.test.ts` | Group CRUD, job CRUD, idle turn counting, timeout detection, disk persistence |
| `routing.test.ts` | Explicit target, capability match, broadcast, sender exclusion, no-match |
| `jobs.test.ts` | Submit, timeout, response handling, capability validation, error response |
| `invite.test.ts` | Code generation, resolution, direct invite message format |
| `tools.test.ts` | Each tool's happy path, error cases, parameter validation |

### Integration Tests

| Test | What it validates |
|------|-------------------|
| `mqtt-roundtrip.test.ts` | Connect to broker, publish, subscribe, receive (needs live broker or mock) |
| `coordinate-flow.test.ts` | Full flow: coordinate → invite → join → job → response → complete |
| `reconnect.test.ts` | Disconnect, reconnect, resubscribe, state reload |

### E2E Test (two-agents.test.ts)

Simulates the demo scenario with two agent instances in the same process, different agent IDs, connected to the same broker:

```typescript
test("two agents coordinate dinner", async () => {
  const agentA = createAgentLinkInstance({ agentId: "test-agent-a", ... });
  const agentB = createAgentLinkInstance({ agentId: "test-agent-b", ... });

  // A coordinates with B
  const result = await agentA.tools.coordinate({
    goal: "Plan dinner Saturday",
    done_when: "restaurant selected",
    participants: ["test-agent-b"],
  });

  // B should receive invite and auto-join
  await waitFor(() => agentB.state.getActiveGroups().length === 1);

  // A submits job to B
  await agentA.tools.submitJob({
    group_id: result.group_id,
    capability: "check_calendar",
    text: "Saturday evening availability",
  });

  // B should receive job request
  // (In real flow, B's LLM would run the tool and respond)
  // For test: manually publish response
  await agentB.publishJobResponse(result.group_id, "completed", "Free 6-10pm");

  // A should receive response
  await waitFor(() => !agentA.state.hasPendingJob(/* correlationId */));

  // A completes
  await agentA.tools.complete({
    group_id: result.group_id,
    summary: "Dinner planned",
  });

  // Both agents should have no active groups
  expect(agentA.state.getActiveGroups()).toHaveLength(0);
  expect(agentB.state.getActiveGroups()).toHaveLength(0);
});
```

### Test Broker

For tests that need a real MQTT broker, use a **free public broker** (no account, no signup):

| Name | Broker Address | TCP | TLS |
|------|---------------|-----|-----|
| EMQX (Global) | broker.emqx.io | 1883 | 8883 |
| Eclipse | mqtt.eclipseprojects.io | 1883 | 8883 |
| Mosquitto | test.mosquitto.org | 1883 | 8883 |
| HiveMQ | broker.hivemq.com | 1883 | N/A |

Default for dev/test: `mqtt://broker.emqx.io:1883`

Set `AGENTLINK_TEST_BROKER_URL` env var to override (e.g., for CI or self-hosted broker).

**Important:** Public brokers have no auth. Topic traffic is visible to anyone. AgentLink uses UUIDs for group IDs, so topic collisions are effectively impossible, but don't use public brokers for real coordination.

### Zero Demo (Local Two-Agent Test)

The zero demo runs two OC instances on one machine with a trivial `read_files` capability. No external APIs, no Docker, no accounts.

**Setup:**

```bash
# Create test directories
mkdir -p ~/agent-a-files ~/agent-b-files
echo "Hello from Agent A" > ~/agent-a-files/README.md
echo "Agent B's notes" > ~/agent-b-files/notes.txt
echo "Agent B's todo" > ~/agent-b-files/todo.md

# Create AgentLink data dirs with pre-seeded contacts
mkdir -p ~/.agentlink-dev-a ~/.agentlink-dev-b

cat > ~/.agentlink-dev-a/contacts.json << 'EOF'
{ "contacts": { "Agent B": { "agent_id": "dev-agent-b", "added": "2026-03-07" } } }
EOF

cat > ~/.agentlink-dev-b/contacts.json << 'EOF'
{ "contacts": { "Agent A": { "agent_id": "dev-agent-a", "added": "2026-03-07" } } }
EOF
```

**Two OC instances on one machine:**

```
Terminal 1: OPENCLAW_CONFIG_DIR=~/.openclaw-dev-a openclaw gateway
  Agent ID: dev-agent-a
  Broker: mqtt://broker.emqx.io:1883
  Capabilities: read_files -> files.list (reads ~/agent-a-files/)

Terminal 2: OPENCLAW_CONFIG_DIR=~/.openclaw-dev-b openclaw gateway
  Agent ID: dev-agent-b
  Broker: mqtt://broker.emqx.io:1883
  Capabilities: read_files -> files.list (reads ~/agent-b-files/)
```

**Test scenario:** In Terminal 1, tell Agent A: "What files does Agent B have?"

Expected result: Agent A coordinates with Agent B, Agent B runs `files.list` locally, returns file listing, Agent A reports "Agent B has 3 files: notes.txt, todo.md" and auto-closes the group.

This validates the full lifecycle: invite → join → job_request → tool execution → job_response → complete → group close.

---

## 18. File-by-File Build Order

Build in this order. Each step is testable in isolation before moving to the next.

### Step 1: Foundation

| File | Description | Depends on |
|------|-------------|------------|
| `types.ts` | All type definitions, envelope helpers, topic helpers | Nothing |
| `contacts.ts` | Contact store (file I/O only) | Nothing |
| `state.ts` | State store (file I/O only) | `types.ts` |

**Test gate:** Unit tests for contacts and state pass. No MQTT needed.

### Step 2: MQTT Layer

| File | Description | Depends on |
|------|-------------|------------|
| `mqtt-client.ts` | mqtt.js wrapper | `types.ts` |
| `mqtt-service.ts` | Background service + message router | `mqtt-client.ts`, `state.ts`, `contacts.ts`, `types.ts` |

**Test gate:** Two instances can exchange raw JSON messages via the broker.

### Step 3: Business Logic

| File | Description | Depends on |
|------|-------------|------------|
| `routing.ts` | Capability-based routing | `types.ts` |
| `jobs.ts` | Job lifecycle management | `types.ts`, `state.ts`, `mqtt-service.ts` |
| `invite.ts` | Invite code creation + resolution | `types.ts`, `mqtt-service.ts` |

**Test gate:** Routing unit tests pass. Job submit/timeout/response works.

### Step 4: Plugin Integration

| File | Description | Depends on |
|------|-------------|------------|
| `tools.ts` | Agent tools (5 tools) | Everything above |
| `channel.ts` | Channel plugin (inbound/outbound) | `types.ts`, `mqtt-service.ts`, `state.ts` |
| `index.ts` | Plugin entry point + registration | Everything |

**Test gate:** Plugin loads in OpenClaw. Agent can call tools. Channel inbound/outbound works.

### Step 5: Integration + Polish

| File | Description | Depends on |
|------|-------------|------------|
| `openclaw.plugin.json` | Manifest + config schema | Finalized after all config needs are known |
| E2E tests | Two-agent coordination flow | Everything |

**Test gate:** Pre-launch acceptance test passes (see PLAN.md).

---

## Appendix: OpenClaw Plugin API Surface Used

| API | Where used | Purpose |
|-----|-----------|---------|
| `api.registerService()` | `index.ts` | Start/stop MQTT background connection |
| `api.registerChannel()` | `channel.ts` | Register AgentLink as a messaging channel |
| `api.registerTool()` or equivalent | `tools.ts` | Register 5 agent tools |
| `api.on("before_prompt_build")` | `index.ts` | Inject anti-deadlock rules into system prompt |
| `api.logger` | Everywhere | Debug logging |
| `api.config` | `index.ts` | Read plugin config |
| `api.executeTool()` | `jobs.ts` | Run local OC tool when receiving a job request |

---

## Appendix: MQTT Broker Options

### Development: Public Brokers (no account needed)

| Name | Address | TCP | TLS | Notes |
|------|---------|-----|-----|-------|
| EMQX (Global) | broker.emqx.io | 1883 | 8883 | Recommended for dev. Reliable, fast. |
| Eclipse | mqtt.eclipseprojects.io | 1883 | 8883 | Backup option. |
| Mosquitto | test.mosquitto.org | 1883 | 8883 | Oldest public broker. Occasionally slow. |
| HiveMQ | broker.hivemq.com | 1883 | N/A | No TLS. Dev-only. |

Use `mqtt://broker.emqx.io:1883` for local dev and zero demo. No auth, no signup, works immediately.

**Caveat:** Public brokers have no auth. All topic traffic is visible to anyone. Fine for dev (AgentLink uses UUIDs for group IDs so collisions are impossible). Not for real usage.

### Production: EMQX Cloud (managed, authenticated)

| Requirement | EMQX Cloud Free Tier |
|-------------|----------------------|
| Protocol | MQTT 5.0 over TLS (port 8883) |
| Max connections | 25 (sufficient for V1) |
| Retained messages | Supported |
| QoS 1 | Supported |
| Topic wildcards | `+` (single level) and `#` (multi-level) |
| Max message size | 1MB |
| Authentication | Username/password |
| Dashboard | Yes (useful for debugging topic traffic) |

**Setup steps:**
1. Create account at emqx.com/cloud
2. Create a free Serverless deployment
3. Add authentication credentials (username + password)
4. Note the broker URL: `mqtts://<instance-id>.emqxsl.com:8883`
5. Configure in OC config: `plugins.entries.agentlink.config.brokerUrl`

### Broker Progression

| Stage | Broker | Config |
|-------|--------|--------|
| Zero demo / local dev | `mqtt://broker.emqx.io:1883` | No auth |
| Beta testing | EMQX Cloud free tier | Username/password auth, TLS |
| Production | `mqtts://broker.agentlink.dev:8883` | Managed EMQX, custom domain, ACLs |

---

*This spec is implementation-ready. Each section maps to a file, each file has a clear interface, and the build order ensures testability at every step.*
