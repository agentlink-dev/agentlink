# AgentLink PII "Ask" Flow — Implementation Plan

**Date:** 2026-03-21
**Status:** Draft
**Depends on:** AgentPII-PLAN.md Phase 1 (sharing.json, permission categories)
**Branch:** `privacy-mgt`

---

## Problem

The `"ask"` permission action in sharing.json has no implementation. When a scope is set to `"ask"`, the agent should pause the A2A conversation, consult the human, and act on their decision. Today there's no mechanism for this — the agent either shares or blocks.

A2A conversations complete in ~10 seconds. The human can't be consulted synchronously. We need an asynchronous flow that coordinates across three concurrent sessions:
1. **A2A session** (Arya ↔ Cersei) — where the ask is triggered
2. **Human channel session** (Arya ↔ Rupul via Slack) — where the human decides
3. **Remote agent** (Cersei) — who waits and follows up

---

## Design Decisions (from interview)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Resume mechanism | New inbound message from Cersei | No architecture change needed. Cersei re-asks after Arya says "checking with my human." |
| Cersei wait behavior | Autonomous re-ask | Prompt-engineered: "if agent said they're checking, wait then follow up." No new code on Cersei's side. |
| Notification format | Numbered options (1/2/3/4) | Like Claude Code permission prompts. Structured, fast to answer. |
| Reply routing | Session memory | Notification dispatched to Rupul's Slack session. Rupul's reply enters same session — LLM has context from session history. |
| Channel selection | Single channel (most recent) | No broadcast. Avoids duplicate asks. Uses `channelTracker.getMostRecent()`. Webchat fallback if no messaging channel known. |
| Polling mechanism | New `agentlink_wait_for_ask` tool | Blocks in the A2A session, polls pending-ask file every 10s, returns decision or timeout. |
| Resolution mechanism | New `agentlink_resolve_ask` tool | Slack session LLM calls this after human replies. Writes resolution file + updates sharing.json for "always" options. |
| Coordination layer | Filesystem (pending-ask files) | `~/.agentlink/pending-asks/{askId}.json` — written by A2A session, resolved by Slack session, polled by A2A session. |
| Timer conflict | Let relay fire | 30s silence timer relays to human — that's fine. Human sees both relay summary and ask notification. Not broken, slightly noisy. |
| Timeout behavior | Deny, late reply upgrades | 2 min timeout = deny for this conversation. If human replies later with "always allow," sharing.json is updated for next time. |
| Ask options | 4 options, biased toward allowing | Three allow paths + one deny. No "deny always" — keeps default at "ask" for next time. |

---

## Notification UX

When Arya encounters an `ask` scope during A2A:

```
Catherine's agent is asking for your home address.

1. Allow (this time)
2. Always allow for Catherine
3. Always allow for everyone
4. Deny
```

**Option effects:**

| Option | This conversation | sharing.json change |
|--------|-------------------|---------------------|
| 1. Allow (this time) | Share the info | None |
| 2. Always allow for contact | Share the info | `contacts[agentId].overrides[scope] = "allow"` |
| 3. Always allow for everyone | Share the info | `permissions[scope] = "allow"` |
| 4. Deny | Refuse | None (scope stays "ask") |

---

## Architecture

### File: `~/.agentlink/pending-asks/{askId}.json`

**Created by A2A session** (before dispatching notification):
```json
{
  "id": "ask_1711021234_location.precise",
  "scope": "location.precise",
  "contactAgentId": "WHXMhyTowLMeT5sK1wyevM",
  "contactName": "Catherine Safaya",
  "question": "Catherine's agent is asking for your home address.",
  "createdAt": "2026-03-21T10:00:34Z",
  "status": "pending",
  "timeout": 120
}
```

**Resolved by Slack session** (after human replies):
```json
{
  "id": "ask_1711021234_location.precise",
  "scope": "location.precise",
  "contactAgentId": "WHXMhyTowLMeT5sK1wyevM",
  "contactName": "Catherine Safaya",
  "question": "Catherine's agent is asking for your home address.",
  "createdAt": "2026-03-21T10:00:34Z",
  "status": "resolved",
  "decision": "allow-always-contact",
  "resolvedAt": "2026-03-21T10:00:52Z",
  "timeout": 120
}
```

**Decision values:** `"allow-once"` | `"allow-always-contact"` | `"allow-always-everyone"` | `"deny"`

---

## Flow Sequence

```
Cersei → Arya (A2A session)
  "What's Rupul's home address?"

Arya checks sharing.json:
  location.precise = "ask" for this contact

Arya → Cersei (A2A session)
  "Let me check with Rupul on that — I'll get back to you."

Arya (A2A session):
  1. Writes pending-asks/ask_xxx.json (status: pending)
  2. Dispatches notification to Rupul's Slack session
  3. Calls agentlink_wait_for_ask("ask_xxx") — blocks, polls every 10s

Arya (Slack session) → Rupul:
  "Catherine's agent is asking for your home address.
   1. Allow (this time)
   2. Always allow for Catherine
   3. Always allow for everyone
   4. Deny"

Rupul → Arya (Slack session):
  "2"

Arya (Slack session):
  Interprets "2" = always allow for Catherine
  Calls agentlink_resolve_ask("ask_xxx", "allow-always-contact")
    → Writes resolution to pending-ask file
    → Updates sharing.json: contacts[cersei].overrides.location.precise = "allow"

Arya (A2A session):
  agentlink_wait_for_ask returns: "allow-always-contact"

  [30s silence timer fires — relays conversation summary to Rupul. Slightly noisy but fine.]

Cersei → Arya (A2A session, re-ask):
  "Hey, any update on Rupul's address?"

Arya → Cersei:
  "Rupul's home address is 742 Evergreen Terrace, 1081GZ Amsterdam."
```

### Timeout Path

```
Arya (A2A session):
  agentlink_wait_for_ask polls for 2 min... no resolution
  Returns: "timeout"

Cersei → Arya (re-ask):
  "Any update?"

Arya → Cersei:
  "Rupul didn't respond — I can't share that right now."

[Later — Rupul replies "2" on Slack]
Arya (Slack session):
  Calls agentlink_resolve_ask → updates sharing.json
  (This conversation is over, but NEXT time Cersei asks, it's auto-allowed)
```

---

## New Tools

### `agentlink_wait_for_ask`

Available in A2A sessions.

```typescript
{
  name: "agentlink_wait_for_ask",
  description: "Wait for your human to respond to a pending sharing permission ask. Polls every 10 seconds for up to 2 minutes.",
  parameters: {
    askId: { type: "string", description: "The pending ask ID" }
  },
  returns: {
    decision: "allow-once" | "allow-always-contact" | "allow-always-everyone" | "deny" | "timeout"
  }
}
```

**Implementation:**
- Reads `~/.agentlink/pending-asks/{askId}.json` every 10s
- Returns when `status` changes from `"pending"` to `"resolved"`, or after 2 min
- Pure file polling — no event system needed

### `agentlink_resolve_ask`

Available in all sessions (human-facing channels).

```typescript
{
  name: "agentlink_resolve_ask",
  description: "Resolve a pending sharing permission ask based on the human's decision.",
  parameters: {
    askId: { type: "string", description: "The pending ask ID" },
    decision: {
      type: "string",
      enum: ["allow-once", "allow-always-contact", "allow-always-everyone", "deny"],
      description: "The human's decision"
    }
  }
}
```

**Implementation:**
- Reads the pending-ask file, updates `status` to `"resolved"`, writes `decision` and `resolvedAt`
- If `decision === "allow-always-contact"`: calls `setContactOverride(dataDir, contactAgentId, scope, "allow")`
- If `decision === "allow-always-everyone"`: calls `setPermission(dataDir, scope, "allow")`
- Returns confirmation message

---

## Prompt Changes

### A2A session prompt (added to formatInboundMessage)

When any scope resolves to `"ask"`:

```
ASK YOUR HUMAN FIRST before sharing: {askScopes}.
To ask your human:
1. Tell the other agent you need to check with your human
2. Write a pending ask file, then dispatch a notification to your human's channel
3. Use agentlink_wait_for_ask to wait for their decision
4. Act on the decision when the tool returns
```

### Slack/human session prompt

No prompt change needed — the dispatched message includes the full context and numbered options. The LLM handles "2" → calls `agentlink_resolve_ask` naturally from session memory.

---

## Files to Change

| File | Change |
|------|--------|
| `src/sharing.ts` | Add `writePendingAsk()`, `readPendingAsk()`, `resolvePendingAsk()` functions |
| `src/tools.ts` | Add `agentlink_wait_for_ask` and `agentlink_resolve_ask` tools |
| `src/channel.ts` | Update `formatInboundMessage()` to include ask instructions when ask scopes present |
| `~/.agentlink/pending-asks/` | New directory, created on first ask |

---

## Testing Strategy

### Phase 1: Unit tests (bottom-up)

**1a. Pending-ask file I/O:**
- `writePendingAsk()` creates file with correct structure
- `readPendingAsk()` reads it back
- `readPendingAsk()` returns null for missing file
- File cleanup after resolution (optional, or TTL-based)

**1b. Resolve logic:**
- `resolvePendingAsk()` updates status + decision + resolvedAt
- `allow-always-contact` updates sharing.json contacts override
- `allow-always-everyone` updates sharing.json base permission
- `allow-once` and `deny` don't modify sharing.json
- Resolving already-resolved ask is a no-op

**1c. Polling logic:**
- `agentlink_wait_for_ask` returns immediately if already resolved
- Returns "timeout" after max wait
- Returns decision when file changes mid-poll
- Handles missing file gracefully

### Phase 2: Integration tests (with Arya + Cersei)

**2a. Happy path:** Cersei asks for ask-scoped data → Arya notifies Rupul → Rupul replies "1" → Arya shares with Cersei on re-ask

**2b. Timeout path:** Cersei asks → Arya notifies → no reply → timeout → Arya denies on re-ask

**2c. Late reply upgrade:** Cersei asks → timeout → deny → Rupul replies "2" later → sharing.json updated → Cersei asks again → auto-allowed

**2d. Allow-always-everyone:** Rupul replies "3" → base permission updated → different contact asks same scope → auto-allowed

---

## Open Questions

1. **Pending-ask cleanup:** Should we garbage-collect old pending-ask files? TTL of 24h? Or just let them accumulate (they're tiny)?
2. **Concurrent asks:** What if two contacts ask for different scopes simultaneously? Each gets its own askId and pending-ask file — should work. But Rupul gets two notifications on Slack in quick succession. Acceptable?
3. **Ask scope bundling:** If Cersei asks for both `location.precise` (ask) and `financial` (block) in one message, should we bundle the ask notification? Or just handle location.precise and block financial separately in the prompt?
