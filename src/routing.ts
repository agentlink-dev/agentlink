import type { MessageEnvelope, AgentStatus, Capability } from "./types.js";

export interface Router {
  resolveTarget(msg: MessageEnvelope, groupParticipants: AgentStatus[]): string[];
}

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
          .filter((p) => p.agent_id !== msg.from)
          .filter((p) => p.capabilities.some((c) => c.name === capName))
          .map((p) => p.agent_id);
      }

      // Rule 3: No capability — broadcast to all except sender
      return groupParticipants
        .filter((p) => p.agent_id !== msg.from)
        .map((p) => p.agent_id);
    },
  };
}

/**
 * Receiver-side: should this agent process the incoming message?
 */
export function shouldProcess(
  msg: MessageEnvelope,
  myAgentId: string,
  myCapabilities: Capability[],
): boolean {
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
