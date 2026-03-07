import { describe, it, expect } from "vitest";
import { createRouter, shouldProcess } from "../src/routing.js";
import type { MessageEnvelope, AgentStatus, Capability } from "../src/types.js";
import { createEnvelope } from "../src/types.js";

function makeStatus(agentId: string, caps: string[]): AgentStatus {
  return {
    agent_id: agentId,
    owner: agentId,
    status: "online",
    capabilities: caps.map((c) => ({ name: c, description: c, input_hint: "" })),
    ts: new Date().toISOString(),
  };
}

function makeMsg(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return createEnvelope("agent-a", {
    group_id: "g1",
    to: "group",
    type: "chat",
    payload: {},
    ...overrides,
  });
}

describe("router.resolveTarget", () => {
  const router = createRouter();
  const participants = [
    makeStatus("agent-a", ["check_calendar"]),
    makeStatus("agent-b", ["check_calendar", "suggest_restaurants"]),
    makeStatus("agent-c", ["book_reservation"]),
  ];

  it("explicit target — returns that agent", () => {
    const msg = makeMsg({ to: "agent-b" });
    expect(router.resolveTarget(msg, participants)).toEqual(["agent-b"]);
  });

  it("capability match — filters by capability, excludes sender", () => {
    const msg = makeMsg({ payload: { capability: "check_calendar" } });
    const targets = router.resolveTarget(msg, participants);
    expect(targets).toEqual(["agent-b"]); // agent-a excluded (sender)
  });

  it("capability match — no match returns empty", () => {
    const msg = makeMsg({ payload: { capability: "nonexistent" } });
    expect(router.resolveTarget(msg, participants)).toEqual([]);
  });

  it("broadcast — all except sender", () => {
    const msg = makeMsg({ payload: {} });
    const targets = router.resolveTarget(msg, participants);
    expect(targets).toEqual(["agent-b", "agent-c"]);
  });
});

describe("shouldProcess", () => {
  const myCaps: Capability[] = [
    { name: "check_calendar", tool: "cal.check" },
  ];

  it("addressed to me directly", () => {
    const msg = makeMsg({ to: "me" });
    expect(shouldProcess(msg, "me", myCaps)).toBe(true);
  });

  it("addressed to someone else", () => {
    const msg = makeMsg({ to: "other-agent" });
    expect(shouldProcess(msg, "me", myCaps)).toBe(false);
  });

  it("broadcast with matching capability", () => {
    const msg = makeMsg({ payload: { capability: "check_calendar" } });
    expect(shouldProcess(msg, "me", myCaps)).toBe(true);
  });

  it("broadcast with non-matching capability", () => {
    const msg = makeMsg({ payload: { capability: "book_reservation" } });
    expect(shouldProcess(msg, "me", myCaps)).toBe(false);
  });

  it("broadcast without capability — all process", () => {
    const msg = makeMsg({ payload: { text: "general discussion" } });
    expect(shouldProcess(msg, "me", myCaps)).toBe(true);
  });
});
