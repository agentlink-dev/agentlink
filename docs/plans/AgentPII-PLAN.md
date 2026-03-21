# AgentLink PII Sharing Policy — Implementation Plan

**Date:** 2026-03-20
**Updated:** 2026-03-21
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
| Storage | `~/.agentlink/sharing.json` | Separate from identity; clean concerns |
| Capability gaps | Policy = intent only | If tool isn't installed, agent says so naturally |
| **Runtime loading** | **Read from file per-message, no restart** | Policy changes take effect on next A2A message without rebuild or gateway restart |

---

## Core Design Principle: Runtime File Loading

**`sharing.json` is read from disk on every inbound A2A message.** This means:

- Editing `~/.agentlink/sharing.json` (manually, via CLI, or via the `agentlink_update_policy` tool) takes effect immediately on the next A2A exchange
- No TypeScript rebuild required
- No gateway restart required
- No session reset required

This is critical for:
1. **User experience** — changing a sharing preference shouldn't require technical steps
2. **The `agentlink_update_policy` tool** — agent updates the file, next message uses the new policy
3. **Testing** — swap sharing.json between test cases without any restart overhead

**Implementation:** `formatInboundMessage()` receives the data dir path (already available via config), reads `sharing.json` at call time, and falls back to hardcoded "open" profile defaults if the file doesn't exist.

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
  "version": 1,
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
  "version": 1,
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
  "version": 1,
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

## sharing.json Schema

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

### 1.1 — sharing.json + profiles (`src/sharing.ts` — new file)

- Define `SharingProfile` type: `"open" | "balanced" | "private"`
- Define `PermissionAction` type: `"allow" | "ask" | "block"`
- Define profile constants: `OPEN_PROFILE`, `BALANCED_PROFILE`, `PRIVATE_PROFILE`
- Functions (stateless, read from disk each call):
  - `readSharing(dataDir: string): SharingConfig` — reads `sharing.json`, returns defaults if missing
  - `resolvePermission(sharing: SharingConfig, scope: string, contactAgentId?: string): PermissionAction`
  - `getAllowedScopes(sharing: SharingConfig, contactAgentId?: string): string[]`
  - `getAskScopes(sharing: SharingConfig, contactAgentId?: string): string[]`
  - `getBlockedScopes(sharing: SharingConfig, contactAgentId?: string): string[]`
  - `writeSharing(dataDir: string, sharing: SharingConfig): void` — atomic write
  - `setProfile(dataDir: string, profile: SharingProfile): void` — resets to profile defaults
  - `setPermission(dataDir: string, scope: string, action: PermissionAction): void`
  - `setContactOverride(dataDir: string, agentId: string, name: string, humanName: string, scope: string, action: PermissionAction): void`
  - `removeContactOverride(dataDir: string, agentId: string, scope: string): void`
- Default profile for new installs: `"open"`
- **No class / no cache** — pure functions that read/write the file. Ensures every call sees the latest state.

### 1.2 — Setup CLI changes (`bin/cli.js`)

**End-of-setup summary (after all other steps):**
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
  Customize: agentlink sharing set calendar.write block
```

**New CLI flags for setup:**
- `--sharing-profile <open|balanced|private>` — override default on setup
- `--block <scope>` — block specific scope (repeatable)
- `--allow <scope>` — allow specific scope (repeatable)

**New CLI commands:**
- `agentlink sharing` — show current sharing summary
- `agentlink sharing set <scope> <allow|ask|block>` — modify base permission
- `agentlink sharing profile <open|balanced|private>` — switch profile (resets to profile defaults)
- `agentlink trust <contact> [--grant <scope>] [--revoke <scope>] [--full]` — per-contact exceptions
  - `--full` sets all scopes to `allow` for that contact

### 1.3 — Dynamic prompt injection (`src/channel.ts`)

> **PRETEST SCAFFOLDING IN PLACE (2026-03-21):**
> A temporary `sharing-prompt.txt` hook was added to `formatInboundMessage()` for pretesting.
> It reads raw text from `~/.agentlink/sharing-prompt.txt` and injects it as the PRIVACY block.
> This must be **replaced** by the structured `sharing.json` reader below.
>
> What to do:
> 1. Remove the `sharing-prompt.txt` file-reading code (lines ~455-473 in channel.ts)
> 2. Remove the `dataDir?: string` parameter from `formatInboundMessage()`
> 3. Implement the production version below, which reads `sharing.json` via `readSharing()`
>    and builds the prompt from structured permission scopes
> 4. The function signature will change to accept a `SharingConfig` object instead of `dataDir`

Replace the **pretest hook** (and original hardcoded PRIVACY block) with structured sharing.json read:

```typescript
// Read sharing policy from disk (no restart needed for changes)
const sharing = readSharing(config.dataDir);
const allowed = getAllowedScopes(sharing, envelope.from);
const askScopes = getAskScopes(sharing, envelope.from);
const blocked = getBlockedScopes(sharing, envelope.from);

lines.push(
  `SHARING POLICY (set by your human):`,
  `You MAY share: ${allowed.join(", ") || "nothing"}.`,
  askScopes.length
    ? `ASK your human first (via notification) before sharing: ${askScopes.join(", ")}.`
    : "",
  `NEVER share: ${blocked.join(", ")}.`,
  `Full policy: ${config.dataDir}/sharing.json`,
  "",
);
```

**Key behavior changes:**
1. The prompt now tells the agent what it CAN share, not just what it can't — flips framing from restrictive to permissive
2. Policy is read from `sharing.json` at message time — edits take effect immediately, no rebuild/restart
3. Per-contact overrides are resolved before injection — trusted contacts get a more permissive prompt automatically

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
- Tool writes to `sharing.json` → next A2A message picks up the change automatically

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

- **Audit log:** Track what was shared, with whom, when (append-only log in `~/.agentlink/sharing-log.jsonl`)
- **Control UI panel:** Visual policy editor in OpenClaw Control UI (requires OC-side work)
- **Capability intersection:** Cross-reference policy with installed tools/skills for accurate whois
- **Group policies:** Apply a policy template to a group of contacts (e.g., "work colleagues" tier)

---

## Files to Change

| File | Change |
|------|--------|
| `src/sharing.ts` | **NEW** — Pure functions for reading/writing sharing.json, profile definitions, resolution logic |
| `src/channel.ts` | Replace hardcoded PRIVACY block with dynamic policy read from `sharing.json` in `formatInboundMessage()` |
| `src/types.ts` | Add `sharing_profile` to `AgentStatus` |
| `src/tools.ts` | Add `agentlink_update_policy` tool; update whois output with sharing policy |
| `src/index.ts` | Pass dataDir to channel functions (already available via config) |
| `bin/cli.js` | Add sharing summary to setup; add `sharing` and `trust` subcommands; add `--sharing-profile`, `--block`, `--allow` flags |
| `~/.agentlink/sharing.json` | **NEW** — runtime sharing policy (read per-message, no restart needed) |

---

## Migration

- Existing installs without `sharing.json`: default to `"open"` profile on first load (`readSharing()` returns defaults)
- No breaking changes to identity.json or contacts.json
- MQTT status payload addition is additive (old agents ignore new field)
- The hardcoded PRIVACY block is removed entirely — replaced by dynamic file-based policy
