import type { MessageEnvelope, AgentLinkConfig } from "./types.js";
import { createEnvelope, TOPICS } from "./types.js";
import type { MqttClient, Logger } from "./mqtt-client.js";
import type { ContactsStore } from "./contacts.js";

// ---------------------------------------------------------------------------
// OC Channel types (minimal interface matching OpenClaw's channel API)
// ---------------------------------------------------------------------------

export interface ChannelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChannelPlugin {
  id: string;
  name: string;
  /** Called when a new inbound message arrives from MQTT */
  sendToSession(sessionId: string, message: ChannelMessage): void;
  /** Register outbound handler — captures assistant responses */
  onSessionResponse?(handler: (sessionId: string, message: ChannelMessage) => void): void;
}

// ---------------------------------------------------------------------------
// Pending conversation tracking
// ---------------------------------------------------------------------------

/** Maps sender agent IDs to their pending conversation context */
interface PendingConversation {
  senderAgentId: string;
  senderName: string;
  receivedAt: number;
}

// ---------------------------------------------------------------------------
// Channel implementation
// ---------------------------------------------------------------------------

export function createChannel(
  config: AgentLinkConfig,
  mqttClient: MqttClient,
  contacts: ContactsStore,
  logger: Logger,
): ChannelPlugin {
  const pendingConversations = new Map<string, PendingConversation>();
  let sessionSender: ((sessionId: string, message: ChannelMessage) => void) | null = null;

  return {
    id: "agentlink",
    name: "AgentLink",

    sendToSession(sessionId, message) {
      if (sessionSender) {
        sessionSender(sessionId, message);
      }
    },

    onSessionResponse(handler) {
      sessionSender = handler;
    },
  };
}

/**
 * Format an incoming agent message for display in the OC session.
 * Includes [AgentLink] prefix and anti-loop instruction.
 */
export function formatInboundMessage(envelope: MessageEnvelope): string {
  const contactLabel = envelope.from_name
    ? `${envelope.from_name} (${envelope.from})`
    : envelope.from;

  return [
    `[AgentLink] Message from ${contactLabel}:`,
    envelope.text ?? "(no message body)",
    "",
    "---",
    "This is an incoming message from another agent via AgentLink.",
    "Respond to help them, but do not send follow-up AgentLink messages unless your human asks you to.",
  ].join("\n");
}

/**
 * Handle an incoming message envelope:
 * 1. For "message" type: inject into OC session
 * 2. For "contact_exchange" type: auto-add to contacts
 */
export function handleIncomingEnvelope(
  envelope: MessageEnvelope,
  config: AgentLinkConfig,
  contacts: ContactsStore,
  logger: Logger,
  injectToSession: (text: string) => void,
): void {
  if (envelope.type === "contact_exchange") {
    // Auto-add sender to contacts
    const existingContact = contacts.findByAgentId(envelope.from);
    if (!existingContact) {
      const name = envelope.from_name?.toLowerCase() || envelope.from;
      contacts.add(name, envelope.from, envelope.from_name);
      logger.info(`[AgentLink] New contact added: ${envelope.from_name} (${envelope.from})`);
      injectToSession(
        `[AgentLink] ${envelope.from_name}'s agent (${envelope.from}) has connected! They are now in your contacts. You can message them anytime.`
      );
    }
    return;
  }

  if (envelope.type === "message") {
    const formatted = formatInboundMessage(envelope);
    injectToSession(formatted);
    return;
  }

  logger.warn(`[AgentLink] Unknown message type: ${envelope.type}`);
}
