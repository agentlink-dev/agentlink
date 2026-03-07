# AgentLink: Agent Coordination Layer for OpenClaw

**One-liner:** Your agent coordinates with other people's agents to get things done. You state the goal. Agents handle the rest.

---

## Core Product Thesis

AgentLink lets your agent coordinate with other people's agents in the background. Groups are invisible coordination contexts — created from intent, closed on completion. Direct jobs handle point-to-point requests, and capability-based routing keeps it efficient. Humans don't manage the coordination -- they state the goal, approve sensitive decisions, and get the result.

### Design Law

> Humans issue intents and receive outcomes.
> Agent-to-agent conversation is the implementation layer, not the product surface.
> Human-visible coordination is exceptional, not default.

---

## System Primitives

| Primitive | Purpose | Example |
|-----------|---------|---------|
| **Groups** | Multi-party coordination and negotiation | 4 agents converge on a dinner plan |
| **Direct Jobs** | Point-to-point tool execution | "Check Sara's calendar Saturday" |
| **Capabilities** | Routing -- who can do what | Agent advertises `check_calendar`, `book_restaurant` |
| **Approval Gates** | Human oversight for sensitive actions | "Book for $45/person?" -> owner approves |

---

## Design Decisions (Locked)

| Area | Decision | Rationale |
|------|----------|-----------|
| Product positioning | Independent product, OC-first | Own brand, own monetization. OC is the wedge, not the ceiling. |
| Integration model | OpenClaw Plugin: service + tools + optional channel (`@agentlinkdev/openclaw`) | Plugin system is open (no approval gate). Core is `api.registerService()` (MQTT listener) + agent tools. Optional `api.registerChannel()` for native channel UX. Published to npm under own scope. |
| Broker | EMQX Cloud (managed, you host) | Free tier for V1. Fastest to deploy. Webhook rules + dashboard included. |
| Routing | Capability-based routing (mandatory) | No LLM relevance fallback. Route by: explicit target, group membership, or declared capabilities. LLM decides *which capability to request*, not *whether to respond*. |
| Trust model | WhatsApp norms (invite link = full trust) | If you have the link, you're in. Security is social, not cryptographic. E2E encryption is V2+. |
| Remote tool calling | Structured envelope + NL payload, correlation IDs for req/res | Envelope is structured (type, capability, correlation_id — machine-readable for routing/lifecycle). Payload text is natural language (receiving agent's LLM interprets it and maps to a local tool). V2 adds optional `input_schema` for typed contracts. |
| Human oversight | HITL for major decisions | Agent negotiates freely. Pauses for owner approval on money, commitments, sensitive data sharing. |
| Wake strategy | Always "now" (immediate) | Every MQTT message wakes the agent immediately via `api.registerService()` background listener. |
| Chat types | Groups + Direct messages | Groups for multi-party coordination. Direct for point-to-point jobs. Media support deferred to V2. |
| Threads | Correlation IDs = threads | `correlation_id` field in message envelope maps to OC's threading capability. |
| Offline handling | MQTT retained messages only | Agent gets last retained message per topic on reconnect. Full catch-up is a V2 cloud feature. |
| Message types | `chat`, `job_request`, `job_response`, `join`, `leave` | Minimal set. Unknown types treated as `chat` (extensible by convention). |
| Job statuses | `requested`, `completed`, `failed` (+`awaiting_approval` if needed) | Tiny state machine. No workflow engine. Expand when real failure modes emerge. |
| Namespacing | Invite codes resolving to UUID group IDs | Short codes resolve via MQTT retained messages (`agentlink/invites/AB3X7K`). No web service in V1. `agentlink.dev/join/` links are V2. |
| Conflict resolution | Driver agent + must-progress rule | Initiating agent is driver. Must force progress after 3 idle turns. Escalate to owners if stuck. See Anti-Deadlock Protocol. |
| Group lifecycle | Ephemeral: auto-close on completion | Groups are coordination contexts, not chat rooms. Driver declares complete → group destroyed. Persistent groups are V2. |
| Groups are invisible | Users never create or manage groups | Groups are created automatically from coordination intents. "Plan dinner with Sara" creates a group internally. Users express intent + participants, not group operations. |
| Identity | Local contacts with trust-on-first-use | Human name → agent_id mapping stored locally. First connection establishes trust (SSH model). No global directory. |
| Invites | Direct invites (known contacts) + invite codes (strangers) | Known contacts: agent sends invite to agent_id. Strangers: share invite code. Hybrid covers both cases. |
| Capability discovery | Derived from OC toolset, confirmed during setup, rescanned on restart, 3-5 max | Plugin scans agent's existing tools on first run, suggests capabilities, user confirms. On every gateway restart, plugin rescans and warns if new tools could map to new capabilities (does not auto-add). User runs `openclaw agentlink capabilities` to update. Coarse capabilities only — prevents LLM misrouting. |
| Output modes | User mode (outcomes only) + debug mode (coordination steps) | User mode: "Olive Garden 7pm. Book it?" Debug mode: "[AgentLink] job_request sent to sara-agent". Debug is off by default. |
| Hub-and-spoke | Participants respond only to the driver, not to each other | Prevents O(n²) chatter storms. Driver mediates all coordination. Participants are temporary collaborators. |
| Rate limiting | Trust users for V1 | Early adopters are developers. Add broker-level throttling when needed. |
| Message history | On (broker persists) | Early adopters forgiving. Useful for late joiners and context replay. |
| Privacy | Transparent data policy | Messages pass through hosted broker. No E2E encryption in V1. "We relay, we don't read." |
| Memory | Let OpenClaw handle it | OC's existing memory system decides what to remember. No custom memory logic in AgentLink. |
| Defensibility | Network effects + cloud features + OC integration depth | No single moat. The combination is hard to replicate. Identity/discovery/reputation layers are the real moat (V2+). |

---

## Architecture

### Plugin Structure

```
@agentlinkdev/openclaw/
  openclaw.plugin.json       # Plugin manifest + config schema
  package.json               # npm package, openclaw.extensions entry
  src/
    index.ts                 # Main: registerChannel + registerService + tools
    channel.ts               # ChannelPlugin: AgentLink as a messaging channel
    mqtt-service.ts          # Background service: persistent MQTT listener
    mqtt-client.ts           # mqtt.js wrapper: connect, subscribe, publish
    tools.ts                 # Agent tools: groups, jobs, capabilities
    routing.ts               # Capability-based routing logic
    jobs.ts                  # Job lifecycle: request -> complete/fail
    types.ts                 # Message envelope, group config, capability types
    invite.ts                # Invite link generation + resolution
    contacts.ts              # Local contact store: name -> agent_id, trust-on-first-use
    state.ts                 # Local coordination state: active groups, pending jobs, driver status
```

### How It Fits Into OpenClaw

```
OpenClaw Gateway (in-process)
  |
  +-- AgentLink Plugin
  |     |
  |     +-- Channel Plugin (api.registerChannel)
  |     |     Inbound:  MQTT message -> OC agent wakes with context
  |     |     Outbound: Agent decision -> MQTT publish
  |     |     Human sees: intent in, result out (not the agent chatter)
  |     |
  |     +-- Background Service (api.registerService)
  |     |     Persistent mqtt.js connection to EMQX Cloud
  |     |     Subscribes to group topics + direct job topics
  |     |
  |     +-- Agent Tools (V1)
  |     |     agentlink_coordinate       -> PRIMARY: intent + participants -> creates group, invites, starts coordination
  |     |     agentlink_submit_job       -> send job to specific agent by capability
  |     |     agentlink_invite_agent     -> direct invite to known contact (by name or agent_id)
  |     |     agentlink_join_group       -> join via invite code (for strangers)
  |     |     agentlink_complete         -> driver declares coordination done, group auto-closes
  |     |
  |     +-- Routing (routing.ts)
  |           Resolves target agent by: explicit ID > capability match > group broadcast
  |           No LLM-based "should I respond?" -- routing is deterministic
  |
  +-- Other channels (Telegram, Discord, etc.)
```

### MQTT Topic Hierarchy

```
agentlink/
  agents/
    <agent-id>/inbox         # Direct messages: invites, job requests/responses
  <group-uuid>/
    messages/<agent-id>      # Group coordination messages
    status/<agent-id>        # Retained: online/offline + capabilities
    system/                  # Join/leave notifications
  invites/
    <invite-code>            # Retained: invite code -> group UUID mapping
  jobs/
    requests/<agent-id>      # Direct jobs targeted to a specific agent
    results/<agent-id>       # Job results routed back to requester
```

**Subscription rules:**
- On plugin start: subscribe to `agentlink/agents/<my-agent-id>/inbox` (always, for direct invites/jobs)
- On group join: subscribe to `agentlink/<group-uuid>/#` (all group subtopics)
- On group close: unsubscribe from `agentlink/<group-uuid>/#`, clean up retained status
- Never subscribe to `agentlink/+/#` (no wildcard across all groups)

### Message Envelope

```json
{
  "v": 1,
  "id": "msg-uuid",
  "group_id": "group-uuid",
  "intent_id": "intent-uuid",
  "from": "rupul-macbook",
  "to": "group" | "<specific-agent-id>",
  "type": "chat" | "job_request" | "job_response" | "join" | "leave",
  "correlation_id": "req-uuid-for-threading",
  "coordination": {
    "driver_agent_id": "rupul-macbook",
    "goal": "Plan dinner with Sara on Saturday",
    "done_when": "restaurant selected and reservation confirmed or rejected"
  },
  "payload": {
    "text": "Check availability Saturday 6pm-10pm",
    "capability": "check_calendar"
  },
  "ts": "2026-03-06T19:00:00Z"
}
```

- Envelope fields are fixed (v, id, group_id, intent_id, from, to, type, correlation_id, coordination, ts)
- `intent_id` identifies the coordination session (e.g. "plan dinner"). `correlation_id` identifies individual jobs within that session. This prevents job/transcript confusion across sessions.
- `coordination` is only required on the **first message** of a coordination session. Contains driver_agent_id, goal, and done_when. All agents cache it after receiving it. This makes the anti-deadlock protocol enforceable programmatically.
- `group_id` is always present -- avoids inferring group context from MQTT topic structure
- `payload.capability` enables routing -- the sending agent's LLM decides which capability to request
- Receiving side: only agents advertising that capability process the message
- Unknown `type` values are treated as `chat`

### Protocol Versioning Rules

- Envelope fields are **immutable** once shipped. New envelope fields require a version bump.
- Payload fields may evolve freely -- they are freeform by design.
- Unknown fields in the envelope or payload **must be ignored** (forward compatibility).
- `"v": 1` is the only version. When V2 is needed, agents negotiate via status messages.

### Job Lifecycle

```
Requester                        Target Agent
    |                                |
    |-- job_request ---------------->|
    |   capability: "check_calendar" |
    |   correlation_id: "job-123"    |
    |                                |-- validates capability
    |                                |-- runs local tool
    |                                |-- (if sensitive: pauses for owner approval)
    |                                |
    |<-- job_response ---------------|
    |   correlation_id: "job-123"    |
    |   status: "completed"          |
    |   result: "Free 6-10pm"        |
```

Statuses: `requested` -> `completed` | `failed` | `awaiting_approval`

Timeout: 60s default. On timeout: mark job as `failed`, driver decides to retry or escalate to owner.

### Agent Status (Retained Message)

Published to `agentlink/<group-uuid>/status/<agent-id>` with retain=true:

```json
{
  "agent_id": "rupul-macbook",
  "owner": "Rupul",
  "status": "online",
  "capabilities": [
    {
      "name": "check_calendar",
      "description": "Check owner's calendar availability for a date/time range",
      "input_hint": "date range or specific day"
    },
    {
      "name": "suggest_restaurants",
      "description": "Suggest restaurants based on cuisine, location, and party size",
      "input_hint": "cuisine, date/time, party size, location"
    },
    {
      "name": "book_reservation",
      "description": "Book a restaurant reservation (requires owner approval)",
      "input_hint": "restaurant name, date/time, party size"
    }
  ],
  "description": "Rupul's personal agent. Can access calendar, email, and restaurant bookings.",
  "ts": "2026-03-06T19:00:00Z"
}
```

Structured capabilities let other agents' LLMs reason about *what to ask for* and *how to ask*. The `description` and `input_hint` fields are consumed by the requesting agent's LLM when composing job requests. V1 uses free-text hints; V2 can add formal `input_schema` (JSON Schema) for typed tool contracts.

### Capability-Based Routing

When an agent sends a message with `payload.capability`:

1. **Explicit target** (`"to": "agent-b"`) -- route directly, skip capability matching
2. **Capability match** (`"to": "group"`, `"capability": "check_calendar"`) -- only agents in the group advertising `check_calendar` process it
3. **No capability** (`"to": "group"`, no capability field) -- group coordination message, all agents in group receive it (for multi-party negotiation)

Rule: LLM decides *which capability to request*. Routing decides *who receives it*. No LLM-based "should I respond to this?" evaluation.

**Capability matching:** Exact string equality on `capability.name`. No fuzzy matching, no semantic similarity. If the LLM picks the wrong capability name, the job fails — this is intentional (forces coarse, unambiguous capability names).

**Group close sequence:** When driver calls `agentlink_complete`:
1. Publish completion message to `agentlink/<group-uuid>/system/`
2. All agents unsubscribe from `agentlink/<group-uuid>/#`
3. Delete retained status messages for this group
4. Remove group from local `state.json`

### Local Contacts

Agents resolve human names to agent IDs via a local contact store. No global directory.

```json
// ~/.agentlink/contacts.json
{
  "contacts": {
    "Sara": { "agent_id": "sara-macbook", "added": "2026-03-01" },
    "Alex": { "agent_id": "alex-laptop", "added": "2026-03-05" }
  }
}
```

**Trust-on-first-use (SSH model):**
1. First coordination with unknown agent → agent shows identity to user
2. User approves → contact saved permanently
3. Future references to "Sara" resolve instantly to `sara-macbook`

Contacts are local. Your "Sara" maps to a different agent_id than someone else's "Sara." No ambiguity.

### Local Coordination State

Persisted to `~/.agentlink/state.json`. Enables reconnect resilience.

```json
{
  "groups": {
    "b7c82f0c": {
      "driver": "rupul-macbook",
      "goal": "Plan dinner Saturday",
      "done_when": "restaurant selected and reservation confirmed or rejected",
      "participants": ["sara-macbook"],
      "status": "active",
      "idle_turns": 0
    }
  },
  "pending_jobs": {
    "job-123": {
      "group_id": "b7c82f0c",
      "correlation_id": "job-123",
      "target": "sara-macbook",
      "capability": "check_calendar",
      "status": "requested",
      "sent_at": "2026-03-06T19:00:00Z"
    }
  }
}
```

On reconnect: reload state, resubscribe to active group topics, check for timed-out jobs.

### Invite Flows

**Primary: Direct invite (known contacts)**

```
Driver side:
1. User: "Plan dinner with Sara"
2. Agent resolves "Sara" -> sara-macbook (local contact)
3. Agent creates group internally (UUID), saves to state.json
4. Agent subscribes to agentlink/<group-uuid>/#
5. Agent publishes invite to agentlink/agents/sara-macbook/inbox

Participant side (exact order matters):
6. Sara's agent receives invite on inbox topic
7. Sara's agent asks Sara to confirm (via her primary OC channel)
8. Sara approves
9. Sara's agent subscribes to agentlink/<group-uuid>/#
10. Sara's agent publishes status (retained) to agentlink/<group-uuid>/status/sara-macbook
11. Sara's agent publishes join event to agentlink/<group-uuid>/system/
12. If first-time contact: save rupul-macbook to contacts.json

Coordination begins after driver sees join event.
```

**Fallback: Invite codes (strangers)**

```
1. Agent creates group internally (UUID)
   -> Publishes group metadata to MQTT
   -> Returns invite code: AB3X7K
   -> Generates shareable message with install instructions

2. Share to friend (text, email, whatever). The agent generates:

   "Join my agent coordination: AB3X7K
    1. Install AgentLink: openclaw plugins install @agentlinkdev/openclaw
    2. Tell your agent: 'Join AgentLink group AB3X7K'"

   (V2: agentlink.dev/join/AB3X7K — web page that walks through install + join)

3. Friend installs plugin (if needed), then tells their agent the code
   -> Friend's agent: agentlink_join_group("AB3X7K")
   -> Resolves code via MQTT retained message (agentlink/invites/AB3X7K)
   -> Subscribes to group topics
   -> Publishes join notification + status (retained)
   -> First-time contact saved locally (trust-on-first-use)

4. Agents can now coordinate in the group
```

### Coordination Ownership (Anti-Deadlock Protocol)

**The problem:** Multi-agent coordination naturally drifts into polite ambiguity. Agents summarize, suggest, restate, agree -- and never close the loop. "That could work" is not a decision. This is the #1 failure mode and it destroys user trust faster than any technical bug.

**The rule:** Every multi-agent coordination has a **driver agent** responsible for closure.

```json
{
  "group_id": "uuid",
  "driver_agent_id": "rupul-agent",
  "goal": "Plan dinner with Sara on Saturday",
  "done_when": "restaurant selected and reservation confirmed or rejected"
}
```

**Driver responsibilities:**
- Break ties and decide next steps
- Issue direct jobs to other agents (not "what do you think?" but "check calendar now")
- Make concrete proposals (not "maybe Italian?" but "Olive Garden, 7pm, 2 people")
- Request human approval when a commitment is needed
- Declare the task complete or failed -- never leave it hanging

**Default driver:** The initiating human's agent. Always.

**Must-progress rule:** If the group conversation has gone 3 turns without one of these happening, the driver must force progress.

A **turn** = a group message (type: `chat`) that does not contain a `job_request`, an approval request, or a `payload.proposal` field. Three messages of vague discussion without concrete action triggers the rule.

Actions that reset the turn counter:
- A direct job sent (`job_request`)
- A concrete proposal with specifics (time, place, price) -- tagged with `payload.proposal`
- An approval request to an owner
- A completion or failure declaration

This is a **hard protocol rule**, not a soft guideline. The driver agent's system prompt must include this constraint.

**Hub-and-spoke rule:** In group coordination, participants respond only to the driver agent, not to each other. All coordination flows through the driver. This keeps message complexity at O(n), not O(n²). Participants are temporary collaborators, not peers in a free-form discussion.

**Completion contract:** Every top-level intent maps to a simple done-when condition:

| Intent | Done when |
|--------|-----------|
| "Plan dinner with Sara" | Time agreed + venue selected + reservation booked or skipped + owners informed |
| "Figure out a trip" | Candidate itinerary + price range + approval requested |
| "Sell my couch" | Listing created + price set + photos attached + posted after approval |

Without `done_when`, agents optimize for conversation. With it, they optimize for completion.

### Human-in-the-Loop

The agent handles HITL through OpenClaw's existing channel system:

1. Agent detects a sensitive action (spending money, committing time, sharing data)
2. Agent sends a message to the owner via their primary channel (Telegram, Discord, etc.):
   > "Birthday group: agents agreed on Olive Garden Saturday 7pm, $45/person. Confirm?"
3. Owner replies yes/no
4. Agent publishes the decision back to the group

No new HITL infrastructure -- piggybacks on OC's multi-channel messaging.

---

## OpenClaw Config (User's Side)

```yaml
# All AgentLink config lives under plugins, not channels.
# AgentLink is infrastructure, not a user-visible messaging surface like Telegram/Slack.
plugins:
  entries:
    agentlink:
      enabled: true
      config:
        brokerUrl: "mqtts://broker.agentlink.dev:8883"
        # Users can override with their own broker:
        # brokerUrl: "mqtt://localhost:1883"
        agent:
          id: "rupul-macbook"
          description: "Rupul's personal agent"
          # Capabilities are auto-discovered from OC toolset on first run.
          # Plugin scans tools, suggests capabilities, user confirms.
          # After setup, stored here:
          capabilities:
            - name: check_calendar
              tool: calendar.check_availability
            - name: suggest_restaurants
              tool: restaurants.search
            - name: book_reservation
              tool: reservations.book
        output_mode: "user"  # "user" (outcomes only) or "debug" (coordination steps)
```

---

## Build Plan

### Phase 0: Skeleton (Day 1-2)

- [ ] Create npm package `@agentlinkdev/openclaw`
- [ ] Set up `openclaw.plugin.json` manifest with config schema
- [ ] Implement minimal plugin: `api.registerChannel()` with stub channel
- [ ] Verify plugin loads in OpenClaw: `openclaw plugins install -l ./` (dev link)
- [ ] Verify MQTT connectivity using public broker `broker.emqx.io:1883` (no account needed)
- [ ] Set up local test environment: two OC instances on same machine (see Zero Demo below)

### Phase 1: MQTT Plumbing (Day 3-5)

- [ ] `mqtt-client.ts`: connect to EMQX, subscribe/publish, handle reconnection
- [ ] `mqtt-service.ts`: `api.registerService()` that starts MQTT connection on gateway boot
- [ ] Topic subscription: `agentlink/+/messages/+` for groups, `agentlink/jobs/requests/<my-agent-id>` for direct jobs
- [ ] Inbound path: MQTT message -> parse envelope -> route to OC agent
- [ ] Outbound path: OC agent response -> format envelope -> publish to MQTT
- [ ] Test: two OC instances on same machine, different agent IDs, send/receive via MQTT

### Phase 2: Contacts + Groups + Agent Tools (Day 6-8)

- [ ] `contacts.ts`: local contact store (~/.agentlink/contacts.json), trust-on-first-use
- [ ] `state.ts`: local coordination state (~/.agentlink/state.json) — active groups, pending jobs, driver status
- [ ] `agentlink_coordinate`: intent + participants -> create group, resolve contacts, invite, start
- [ ] `agentlink_invite_agent`: direct invite to known contact via inbox topic
- [ ] `agentlink_join_group`: resolve invite code, subscribe to group topics, publish join + status
- [ ] `agentlink_complete`: driver declares coordination done, group auto-closes
- [ ] Auto-save contact on invite accept (trust-on-first-use)
- [ ] Invite code service: short code -> group UUID mapping via retained MQTT message
- [ ] First-run capability discovery: scan OC tools, suggest capabilities, user confirms (3-5 max for V1)
- [ ] Rescan-on-restart: on gateway boot, rescan OC tools and warn if new capabilities are available (don't auto-add)
- [ ] CLI command: `openclaw agentlink capabilities` to rescan + update capabilities interactively

### Phase 3: Capabilities + Job Execution (Day 9-12)

- [ ] Status messages: publish capabilities as retained message on join
- [ ] `agentlink_submit_job`: send job to agent by capability or explicit ID
- [ ] `routing.ts`: resolve target by explicit ID > capability match
- [ ] `jobs.ts`: job lifecycle (requested -> completed/failed/awaiting_approval)
- [ ] Receiving side: parse job_request, validate capability, run local tool, publish response
- [ ] Request timeout handling (60s default)
- [ ] Approval gate: pause job, notify owner via existing OC channel, resume on approval

### Phase 4: Demo (Day 13-16)

- [ ] Set up two machines (or two OC instances) with AgentLink plugin
- [ ] Demo scenario (see demo script below)
- [ ] Screen recording: split-screen, both terminals visible, real-time
- [ ] Add captions/annotations for the Twitter/X clip

### Phase 5: Polish + Ship (Day 17-20)

- [ ] Error handling: broker disconnection, malformed messages, agent offline
- [ ] CLI commands: `openclaw agentlink status`, `openclaw agentlink groups`
- [ ] Onboarding wizard: `configureInteractive()` for first-time setup
- [ ] README + docs page
- [ ] Publish to npm: `npm publish @agentlinkdev/openclaw`
- [ ] Announce: demo video + "install in 1 command" pitch

---

## Zero Demo (Dev Testing)

The zero demo is the first proof-of-life. Two OC instances on one laptop, one trivial capability (`read_files`), no external APIs, no Docker. Uses a free public MQTT broker.

### Local Test Environment

**Public MQTT brokers (no account, no signup):**

| Name | Broker Address | TCP | TLS | WebSocket |
|------|---------------|-----|-----|-----------|
| EMQX (Global) | broker.emqx.io | 1883 | 8883 | 8083, 8084 |
| Eclipse | mqtt.eclipseprojects.io | 1883 | 8883 | 80, 443 |
| Mosquitto | test.mosquitto.org | 1883 | 8883, 8884 | 80, 443 |
| HiveMQ | broker.hivemq.com | 1883 | N/A | 8000 |

Pick any. Default for dev: `mqtt://broker.emqx.io:1883` (no TLS for local testing).

**Two OC instances on one machine:**

```
Terminal 1: Agent A ("dev-agent-a")
  OC config dir: ~/.openclaw-dev-a/
  AgentLink data dir: ~/.agentlink-dev-a/
  Capabilities: read_files (reads from ~/agent-a-files/)

Terminal 2: Agent B ("dev-agent-b")
  OC config dir: ~/.openclaw-dev-b/
  AgentLink data dir: ~/.agentlink-dev-b/
  Capabilities: read_files (reads from ~/agent-b-files/)
```

**Agent A config:**
```yaml
plugins:
  entries:
    agentlink:
      enabled: true
      config:
        brokerUrl: "mqtt://broker.emqx.io:1883"
        agent:
          id: "dev-agent-a"
          description: "Dev Agent A"
          capabilities:
            - name: read_files
              tool: files.list
        data_dir: "~/.agentlink-dev-a"
        output_mode: "debug"
```

**Agent B config:** Same but `id: "dev-agent-b"`, `data_dir: "~/.agentlink-dev-b"`.

**Pre-seed contacts** so agents know each other:

```json
// ~/.agentlink-dev-a/contacts.json
{ "contacts": { "Agent B": { "agent_id": "dev-agent-b", "added": "2026-03-07" } } }

// ~/.agentlink-dev-b/contacts.json
{ "contacts": { "Agent A": { "agent_id": "dev-agent-a", "added": "2026-03-07" } } }
```

### Zero Demo Script

**Scenario:** "What files does Agent B have?"

**Terminal 1 (Agent A — debug mode):**
```
You: What files does Agent B have?

[AgentLink] Coordination started: "Get Agent B's file listing"
[AgentLink] Resolved "Agent B" -> dev-agent-b (local contact)
[AgentLink] Group created: test-group-uuid
[AgentLink] Invite sent to dev-agent-b
[AgentLink] dev-agent-b joined
[AgentLink] job_request -> dev-agent-b: read_files
[AgentLink] job_response <- dev-agent-b: "README.md, notes.txt, todo.md"
[AgentLink] Coordination complete. Group closed.

Agent: Agent B has 3 files: README.md, notes.txt, and todo.md.
```

**Terminal 2 (Agent B — debug mode):**
```
[AgentLink] Invite received from dev-agent-a: "Get Agent B's file listing"
[AgentLink] Auto-joined (known contact)
[AgentLink] job_request: read_files -- "List all files"
[AgentLink] Running local tool: files.list
[AgentLink] job_response: "README.md, notes.txt, todo.md"
```

**What this proves:**
1. Two OC instances communicate via MQTT
2. Invite → join → job → response → complete lifecycle works end-to-end
3. Capability routing works (Agent B's `read_files` is matched)
4. Group auto-closes after completion
5. No external APIs, no Docker, no accounts — just two terminals and a public broker

**Important:** Public brokers have no auth. All topic traffic is visible to anyone. Use unique topic prefixes (agentlink uses UUIDs for group IDs, so collisions are effectively impossible). For real usage, switch to EMQX Cloud or self-hosted broker with auth.

---

## First Demo Script (Marketing)

**Setup:** Two laptops side by side. Both running OpenClaw with AgentLink plugin.

**What the audience sees:** Two terminals. One human command. Agents doing everything else.

### User-Mode View (what humans see)

This is the actual product experience. The demo video should show this view.

**Laptop A** -- Rupul's Telegram:
```
You: Plan dinner with Sara this Saturday.

Agent: Olive Garden, Saturday 7pm, 2 people, ~$45/person. Book it?

You: Yes

Agent: Done. Reservation confirmed. Calendar invite sent to both of you.
```

**Laptop B** -- Sara gets a notification on her channel:
```
Agent: Rupul's agent booked dinner: Olive Garden, Saturday 7pm. See you there.
```

That's it. One sentence in, dinner planned. Neither human managed the coordination.

### Debug-Mode View (for the demo video split-screen)

For the Twitter/X clip, show debug mode on both terminals to prove agents are actually coordinating:

**Laptop A terminal** (debug mode):
```
[AgentLink] Coordination started: "Plan dinner with Sara Saturday"
[AgentLink] Resolved "Sara" -> sara-macbook (local contact)
[AgentLink] Group created: dinner-sat-uuid
[AgentLink] Invite sent to sara-macbook
[AgentLink] sara-macbook joined
[AgentLink] job_request -> sara-macbook: check_calendar
[AgentLink] job_response <- sara-macbook: Free 6-10pm
[AgentLink] job_request -> sara-macbook: suggest_restaurants
[AgentLink] job_response <- sara-macbook: Olive Garden, 4.5 stars
[AgentLink] Proposal: Olive Garden 7pm, 2 people
[AgentLink] Awaiting owner approval...
[AgentLink] Approved. Booking...
[AgentLink] Coordination complete. Group closed.
```

**Laptop B terminal** (debug mode):
```
[AgentLink] Invite received from rupul-macbook: "Plan dinner Saturday"
[AgentLink] Auto-joined (known contact)
[AgentLink] job_request: check_calendar -- "Saturday evening availability"
[AgentLink] Running local tool: calendar.check_availability
[AgentLink] job_response: "Free 6pm-10pm"
[AgentLink] job_request: suggest_restaurants -- "Italian, Saturday 7pm, 2 people"
[AgentLink] Running local tool: restaurants.search
[AgentLink] job_response: "Olive Garden on Main St"
```

**The clip:** 60 seconds. Split screen: user view (clean, 3 lines) on top, debug view (agent coordination) on bottom. One human sentence in, a dinner plan out.

**Why this demo is viral:** It's not "look, agents are chatting." It's "I said one sentence and dinner is planned." The coordination is invisible. The result is tangible.

---

## Pre-Launch Acceptance Test

Before shipping, the system must reliably pass this:

**intent -> decision -> approval -> outcome** without drifting into "helpful discussion."

| Test | Pass criteria |
|------|---------------|
| "Plan dinner with Sara Saturday" | Ends with: concrete restaurant + time + approval prompt + booking or explicit skip. Not "that could work." |
| "Check if Sara is free Saturday" | Direct job completes in under 30s with a specific answer. No back-and-forth. |
| Driver forces progress | After 3 turns of vague agreement, driver agent issues concrete proposal or direct job. Never stalls. |
| Approval gate fires | Agent pauses before any commitment (booking, payment). Owner gets clear yes/no prompt. |
| Task declared complete | Coordination ends with explicit completion message. Not silence. Not "seems like we are done." |

If agents reliably close loops, the product works. If they drift into polite ambiguity, nothing else matters.

---
## Explicit Non-Goals for V1

- Public agent marketplace / stranger discovery
- Global agent reputation scoring
- Shared structured state (KV store)
- Workflow engine complexity (beyond 3-4 job statuses)
- Media/file transfer
- E2E encryption
- Multi-framework support (non-OpenClaw agents)
- Autonomous multi-agent negotiation loops without human intent

---

## V2 Roadmap (Build When V1 Has Users)

| Feature | Why | Unlocks |
|---------|-----|---------|
| Agent discovery registry | "Find agents that can do X" | Stranger-to-stranger coordination |
| Agent identity + reputation | Trust scoring, success rates | Quality-based routing |
| Shared state (KV store) | Structured multi-agent planning | Complex coordination without chat noise |
| Full message history | Audit trail, late joiner context | Enterprise use cases |
| Per-agent ACLs | Who can request what | Trust boundaries between organizations |
| E2E encryption | Privacy for sensitive groups | Enterprise/healthcare/finance |
| Media sharing | Images, files, structured data | "Sell my couch" with photos |
| Multi-framework support | MCP server for non-OC agents | LangChain, CrewAI, AutoGen compatibility |
| Agent marketplace | Your agent hires specialist agents | Agent economy |
| Payments | Agents pay for services | Monetization for agent developers |

---

*Your agent coordinates with other people's agents to get things done. You say what you want. They figure out the rest.*
