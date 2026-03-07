# AgentLink Build Instructions

You are building **AgentLink** — an OpenClaw plugin (`@agentlinkdev/openclaw`) that lets OC agents coordinate with each other over MQTT. Think "WhatsApp groups for AI agents."

## What You're Building

A TypeScript OpenClaw plugin. When installed, it gives an OC agent 5 new tools that let it create coordination groups, invite other agents, submit jobs, and close loops. Under the hood, agents communicate via MQTT pub/sub through a shared broker.

**npm org:** `@agentlinkdev` (secured)
**GitHub org:** `github.com/agentlink-dev` (secured)
**Package name:** `@agentlinkdev/openclaw`

## Source of Truth

Two docs contain everything you need. Read both before writing any code.

- **PLAN.md** — Product design, architecture, protocol, design decisions, demo scripts. Read this to understand *what* and *why*.
- **SPEC.md** — Engineering spec with TypeScript interfaces, file-by-file implementation details, and build order. Read this to understand *how*.

These docs are authoritative. If something in the code contradicts PLAN.md or SPEC.md, the docs win. If you find a gap in the docs while building, flag it — don't guess.

## Build Order

Follow SPEC.md Section 18 ("File-by-File Build Order") exactly. Each step has a test gate — don't move to the next step until the current one passes.

### Step 1: Foundation (no MQTT needed)
1. `src/types.ts` — All TypeScript interfaces, message envelope, topic helpers, config types
2. `src/contacts.ts` — Local contact store (`~/.agentlink/contacts.json`), trust-on-first-use
3. `src/state.ts` — Local coordination state (`~/.agentlink/state.json`), groups, jobs, idle turns

**Test gate:** Unit tests for contacts and state pass.

### Step 2: MQTT Layer
4. `src/mqtt-client.ts` — Thin `mqtt.js` wrapper (connect, subscribe, publish, reconnect)
5. `src/mqtt-service.ts` — Background service + message router (inbox, group, status, system handlers)

**Test gate:** Two instances exchange JSON messages via `mqtt://broker.emqx.io:1883`.

### Step 3: Business Logic
6. `src/routing.ts` — Receiver-side capability routing (explicit target > capability match > broadcast)
7. `src/jobs.ts` — Job lifecycle (submit, timeout, response, capability validation)
8. `src/invite.ts` — Invite code creation (retained MQTT messages) + resolution + shareable install message

**Test gate:** Routing unit tests pass. Job submit/timeout/response works.

### Step 4: Plugin Integration
9. `src/tools.ts` — 5 agent tools (see below)
10. `src/channel.ts` — Optional OC channel registration (inbound MQTT -> agent, outbound agent -> MQTT)
11. `src/index.ts` — Plugin entry point: wire everything, register service/tools/channel/CLI

**Test gate:** Plugin loads in OpenClaw. Agent can call tools.

### Step 5: Integration + Polish
12. `openclaw.plugin.json` — Plugin manifest with JSON Schema config validation
13. E2E tests — Two-agent coordination flow (zero demo scenario)

**Test gate:** Zero demo passes (see below).

## The 5 Agent Tools

These are the tools the LLM calls. Exact schemas are in SPEC.md Section 12.

| Tool | Purpose |
|------|---------|
| `agentlink_coordinate` | PRIMARY. Intent + participants -> create group, invite, start coordination |
| `agentlink_submit_job` | Send a job to an agent by capability (e.g. "check_calendar") |
| `agentlink_invite_agent` | Invite a known contact to an existing group |
| `agentlink_join_group` | Join a group via 6-char invite code |
| `agentlink_complete` | Driver declares coordination done, group auto-closes |

## Key Architecture Decisions (Do Not Deviate)

- **OpenClaw Plugin**, not a standalone service. Uses `api.registerService()`, `api.registerChannel()`, and agent tools.
- **MQTT transport** via `mqtt.js`. No WebSocket, no HTTP polling, no libp2p.
- **Hub-and-spoke coordination.** Driver agent mediates. Participants respond only to driver, not each other.
- **Ephemeral groups.** Created from intent, auto-close on completion. Not persistent chat rooms.
- **Structured envelope + NL payload.** The message envelope (type, capability, correlation_id) is machine-readable. The payload text is natural language for the receiving LLM.
- **Capability routing is receiver-side.** Every agent in a group gets every message. The receiver decides if it should process based on `shouldProcess()` (SPEC.md Section 10).
- **Exact string matching on capabilities.** No fuzzy matching, no semantic similarity.
- **Anti-deadlock protocol.** Driver must force progress after 3 idle turns. Enforced via idle_turns counter in state + system prompt injection via `api.on("before_prompt_build")`. See PLAN.md "Coordination Ownership" section.
- **Local state persistence.** `~/.agentlink/state.json` and `contacts.json`. Synchronous writes. Reload on restart.
- **HITL piggybacks on OC's existing channel system.** No new approval infrastructure.

## MQTT Broker for Development

Use a free public broker. No Docker, no accounts.

```
mqtt://broker.emqx.io:1883
```

No auth needed. Topic collisions impossible (AgentLink uses UUIDs for group IDs). Don't use for real coordination — switch to EMQX Cloud with auth for anything beyond dev.

## Zero Demo (Your First E2E Test)

Two OC instances on one machine, both pointing at `mqtt://broker.emqx.io:1883`. Agent A has capability `read_files`. Agent B has capability `read_files`. Pre-seeded contacts so they know each other.

**Scenario:** Tell Agent A "What files does Agent B have?"

Expected flow: `coordinate -> invite -> join -> job_request(read_files) -> job_response -> complete -> group close`

Full setup details (config, contacts, directory structure) are in PLAN.md "Zero Demo" section and SPEC.md Section 17 "Zero Demo."

## OpenClaw Plugin API Surface

You'll use these OC APIs (see SPEC.md Appendix for full list):

| API | Purpose |
|-----|---------|
| `api.registerService({ id, start, stop })` | Background MQTT connection |
| `api.registerChannel({ plugin })` | AgentLink as a messaging channel |
| `api.registerTool()` or equivalent | Register the 5 agent tools |
| `api.on("before_prompt_build")` | Inject anti-deadlock rules into system prompt |
| `api.registerCli(({ program }) => {...})` | CLI: `openclaw agentlink status/capabilities` |
| `api.executeTool(toolId, params)` | Run a local OC tool when receiving a job request |
| `api.logger` | Debug logging (`[AgentLink] ...`) |

Refer to the OpenClaw plugin docs for exact signatures: https://docs.openclaw.ai/plugins/

## What NOT to Build

These are explicit V1 non-goals (PLAN.md "Explicit Non-Goals"):

- No agent marketplace / stranger discovery
- No reputation scoring
- No shared KV store
- No workflow engine beyond 3-4 job statuses
- No media/file transfer
- No E2E encryption
- No multi-framework support (OC-only for V1)
- No autonomous agent loops without human intent

## Dependencies

```json
{
  "dependencies": {
    "mqtt": "^5.10.0",
    "uuid": "^11.0.0"
  },
  "peerDependencies": {
    "openclaw": "*"
  }
}
```

That's it. Two runtime deps.

## When in Doubt

1. Read PLAN.md and SPEC.md — the answer is almost certainly there
2. If you find a gap, flag it rather than guessing
3. Keep it simple — V1 is about proving the coordination loop works, not handling every edge case
4. The anti-deadlock protocol is the most important thing to get right. If agents drift into polite ambiguity instead of closing loops, nothing else matters.
