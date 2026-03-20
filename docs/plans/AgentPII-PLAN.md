# AgentLink PII Sharing Policy — Implementation Plan

**Date:** 2026-03-20
**Status:** Draft
**Scope:** Replace hardcoded A2A privacy block with configurable, per-human sharing policy

---

## Problem

The current A2A prompt in `formatInboundMessage()` (`src/channel.ts:444-453`) has a hardcoded PRIVACY block:

```
PRIVACY: If the other agent asks for personally identifiable information
(home address, phone number, email, financial details, health info),
do NOT share it. Politely decline...
```

This treats all contacts identically — a spouse's agent gets the same refusal as a stranger. Combined with Haiku's tendency to over-interpret safety instructions, this creates adversarial, frustrating A2A conversations (see: Arya vs Gandalf incident, 2026-03-20).

**Goal:** Configurable sharing policy that makes A2A coordination collaborative by default, while preserving meaningful privacy boundaries.

---

## Design Decisions (from interview)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Default sharing tier | Sensible defaults (generous) | Viral growth among trusted groups > safety theater |
| Setup UX | Profile-based (Open/Balanced/Private) | Fast, opinionated, low friction |
| Prompt injection | Compact summary + file path fallback | Token-efficient on Haiku |
| Whois exposure | Profile name in MQTT status, detail via tool | Signal without full exposure |
| Permission granularity | Broad categories + CRUD | `calendar.read` vs `calendar.write` matters; avoid OAuth scope explosion |
| Mid-convo "ask" flow | Relay to human via pushNotification | Mirrors exec approvals: allow-once / allow-always / deny |
| Per-contact exceptions | CLI + natural language | `agentlink trust` CLI + agent interprets NL and calls tool |
| Policy update mechanism | New `agentlink_update_policy` tool | Type-safe, validated, single source of truth |
| Storage | `~/.agentlink/policy.json` | Separate from identity; clean concerns |
| Capability gaps | Policy = intent only | If tool isn't installed, agent says so naturally |

---

## Permission Categories

Broad categories with CRUD sub-scopes where meaningful:

| Category | Sub-scopes | Description |
|----------|-----------|-------------|
| `calendar` | `.read`, `.write` | Read schedule/availability; create/modify events |
| `location` | `.general`, `.precise` | City-level vs exact address/coordinates |
| `contacts` | `.names`, `.details` | Contact names vs full contact info (email, phone) |
| `preferences` | — | Interests, dietary, travel preferences, etc. |
| `work` | `.context`, `.files` | What they're working on; access to shared docs |
| `communication` | `.history` | Message/chat history, recent conversations |
| `financial` | — | Bank, salary, transactions, billing |
| `health` | — | Medical, fitness, health data |

**CRUD semantics:**
- `.read` = share existing information (default sub-scope when none specified)
- `.write` = create/modify on behalf of requester (e.g., book a calendar event)

Categories without sub-scopes (preferences, financial, health) use the category name directly with implicit `.read`.

---

## Sharing Profiles

### Open (recommended default for early adopters)

```json
{
  "profile": "open",
  "permissions": {
    "calendar.read": "allow",
    "calendar.write": "ask",
    "location.general": "allow",
    "location.precise": "ask",
    "contacts.names": "allow",
    "contacts.details": "ask",
    "preferences": "allow",
    "work.context": "allow",
    "work.files": "ask",
    "communication.history": "ask",
    "financial": "block",
    "health": "block"
  }
}
```

### Balanced

```json
{
  "profile": "balanced",
  "permissions": {
    "calendar.read": "allow",
    "calendar.write": "ask",
    "location.general": "allow",
    "location.precise": "ask",
    "contacts.names": "allow",
    "contacts.details": "ask",
    "preferences": "allow",
    "work.context": "allow",
    "work.files": "ask",
    "communication.history": "block",
    "financial": "block",
    "health": "block"
  }
}
```

### Private

```json
{
  "profile": "private",
  "permissions": {
    "calendar.read": "ask",
    "calendar.write": "block",
    "location.general": "ask",
    "location.precise": "block",
    "contacts.names": "ask",
    "contacts.details": "block",
    "preferences": "allow",
    "work.context": "ask",
    "work.files": "block",
    "communication.history": "block",
    "financial": "block",
    "health": "block"
  }
}
```

---

## policy.json Schema

```json
{
  "version": 1,
  "profile": "open",
  "permissions": {
    "calendar.read": "allow",
    "calendar.write": "ask",
    "...": "..."
  },
  "contacts": {
    "<agent_id>": {
      "name": "gandalf",
      "human_name": "Bhaskar Deol",
      "overrides": {
        "calendar.write": "allow",
        "location.precise": "allow"
      }
    }
  }
}
```

**Resolution order:** `contacts[agent_id].overrides[scope]` > `permissions[scope]` > `block` (default)

---

## Phase 1: Core Policy System

### 1.1 — policy.json + profiles (`src/policy.ts` — new file)

- Define `SharingProfile` type: `"open" | "balanced" | "private"`
- Define `PermissionAction` type: `"allow" | "ask" | "block"`
- Define `PolicyStore` class:
  - `constructor(dataDir: string)` — loads/creates policy.json
  - `getProfile(): SharingProfile`
  - `resolve(scope: string, contactAgentId?: string): PermissionAction` — resolution with contact overrides
  - `getPermissionMap(contactAgentId?: string): Record<string, PermissionAction>` — full resolved map
  - `getAllowedScopes(contactAgentId?: string): string[]` — for prompt injection
  - `getAskScopes(contactAgentId?: string): string[]`
  - `setProfile(profile: SharingProfile): void`
  - `setPermission(scope: string, action: PermissionAction): void`
  - `setContactOverride(agentId: string, name: string, humanName: string, scope: string, action: PermissionAction): void`
  - `removeContactOverride(agentId: string, scope: string): void`
  - `save(): void`
- Hardcoded profile definitions (OPEN_PROFILE, BALANCED_PROFILE, PRIVATE_PROFILE)
- Default profile for new installs: `"open"`

### 1.2 — Setup CLI changes (`bin/cli.js`)

**End-of-setup summary:**
```
=== Sharing Policy ===
Profile: Open (default)

  Your agent will share with connected agents:
    calendar (read), location (general), contacts (names),
    preferences, work context

  Your agent will ask you first for:
    calendar (write), location (precise), contacts (details),
    work files, communication history

  Your agent will never share:
    financial info, health data

  Override: agentlink setup --sharing-profile balanced|private
  Customize: agentlink policy set calendar.write block
```

**New CLI flags:**
- `--sharing-profile <open|balanced|private>` — override default on setup
- `--block <scope>` — block specific scope (repeatable)
- `--allow <scope>` — allow specific scope (repeatable)

**New CLI commands:**
- `agentlink policy` — show current policy summary
- `agentlink policy set <scope> <allow|ask|block>` — modify base permission
- `agentlink policy profile <open|balanced|private>` — switch profile (resets to profile defaults)
- `agentlink trust <contact> [--grant <scope>] [--revoke <scope>] [--full]` — per-contact exceptions
  - `--full` sets all scopes to `allow` for that contact

### 1.3 — Prompt injection (`src/channel.ts`)

Replace the hardcoded PRIVACY block in `formatInboundMessage()` with dynamic policy:

```typescript
// Build compact sharing policy for prompt
const policy = config.policyStore;
const allowed = policy.getAllowedScopes(envelope.from);
const askScopes = policy.getAskScopes(envelope.from);
const blocked = policy.getBlockedScopes(envelope.from);

lines.push(
  `SHARING POLICY (set by your human):`,
  `You MAY share: ${allowed.join(", ") || "nothing"}.`,
  askScopes.length ? `ASK your human first (via notification) before sharing: ${askScopes.join(", ")}.` : "",
  `NEVER share: ${blocked.join(", ")}.`,
  `Full policy: ${config.dataDir}/policy.json`,
  "",
);
```

**Key behavior change:** The prompt now tells the agent what it CAN share, not just what it can't. This flips the framing from restrictive to permissive.

### 1.4 — Whois exposure

**MQTT status payload** (`createStatusPayload` in `src/types.ts`):
- Add `sharing_profile?: string` field (just the profile name: "open", "balanced", "private")

**agentlink_whois tool** (`src/tools.ts`):
- Add `sharing_policy` section to whois output:
  ```
  Sharing Policy: Open
  Will share: calendar (read), availability, location (general), ...
  Ask first: calendar (write), location (precise), ...
  Blocked: financial, health
  ```
- When querying a contact, return their advertised policy from their MQTT status (profile name) + any detailed info if available

### 1.5 — agentlink_update_policy tool (`src/tools.ts`)

New tool available to the agent in all sessions:

```
agentlink_update_policy
  action: "set_profile" | "set_permission" | "set_contact_override" | "remove_contact_override"
  profile?: "open" | "balanced" | "private"
  scope?: string (e.g., "calendar.write")
  permission?: "allow" | "ask" | "block"
  contact?: string (agent ID or contact name)
  contact_human_name?: string
```

This enables the NL flow:
- Human says: "Let Bhaskar's agent write to my calendar"
- Agent calls: `agentlink_update_policy({ action: "set_contact_override", contact: "gandalf", scope: "calendar.write", permission: "allow" })`

### 1.6 — Mid-conversation "ask" relay

When the agent encounters an "ask" scope during an A2A conversation:

1. Agent's prompt tells it to notify the human before sharing "ask" items
2. Agent calls `pushNotification()` (existing) with message:
   ```
   Bhaskar's agent is asking for your precise location.
   Reply: allow-once / allow-always / deny
   ```
3. Human responds on their active channel (Slack, WhatsApp, webchat)
4. If "allow-always": agent calls `agentlink_update_policy` to promote the scope for that contact
5. Agent continues the A2A conversation with the answer

**Note:** This is a soft enforcement — the LLM interprets the policy and acts on it. There's no hard gate blocking tool calls. The policy is guidance, not a firewall.

---

## Phase 2: Refinements (future)

- **Policy sync across sessions:** When policy changes mid-conversation, other active sessions pick up changes on next exchange
- **Audit log:** Track what was shared, with whom, when (append-only log in `~/.agentlink/sharing-log.jsonl`)
- **Control UI panel:** Visual policy editor in OpenClaw Control UI (requires OC-side work)
- **Capability intersection:** Cross-reference policy with installed tools/skills for accurate whois
- **Group policies:** Apply a policy template to a group of contacts (e.g., "work colleagues" tier)

---

## Files to Change

| File | Change |
|------|--------|
| `src/policy.ts` | **NEW** — PolicyStore class, profile definitions, resolution logic |
| `src/channel.ts` | Replace hardcoded PRIVACY block with dynamic policy injection in `formatInboundMessage()` |
| `src/types.ts` | Add `sharing_profile` to `AgentStatus`, add `policyStore` to `AgentLinkConfig` |
| `src/tools.ts` | Add `agentlink_update_policy` tool; update whois output with sharing policy |
| `src/index.ts` | Initialize PolicyStore at plugin load; pass to channel + tools |
| `bin/cli.js` | Add policy summary to setup; add `policy` and `trust` subcommands; add `--sharing-profile`, `--block`, `--allow` flags |
| `~/.agentlink/policy.json` | **NEW** — runtime policy storage |

---

## Migration

- Existing installs without `policy.json`: default to `"open"` profile on first load (PolicyStore auto-creates)
- No breaking changes to identity.json or contacts.json
- MQTT status payload addition is additive (old agents ignore new field)
- The hardcoded PRIVACY block is removed entirely — replaced by dynamic policy
