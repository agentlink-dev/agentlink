import type { AgentLinkConfig, MessageEnvelope, AgentStatus } from "./types.js";
import { TOPICS, parseSenderFromTopic, parseEnvelope } from "./types.js";
import type { MqttClient, Logger } from "./mqtt-client.js";
import { createMqttClient } from "./mqtt-client.js";

export type MessageHandler = (envelope: MessageEnvelope) => void;
export type StatusHandler = (agentId: string, status: AgentStatus) => void;

export interface MqttService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getClient(): MqttClient;
  onMessage(handler: MessageHandler): void;
  isConnected(): boolean;
}

export function createMqttService(
  config: AgentLinkConfig,
  logger: Logger,
): MqttService {
  const client = createMqttClient(config, logger);
  const messageHandlers: MessageHandler[] = [];

  function handleIncoming(topic: string, payload: Buffer) {
    const senderId = parseSenderFromTopic(topic);
    if (!senderId) return; // Not an inbox message

    const raw = payload.toString("utf-8");
    const envelope = parseEnvelope(raw);
    if (!envelope) {
      logger.warn(`[AgentLink] Invalid message on ${topic}`);
      return;
    }

    // Ignore our own messages (shouldn't happen with sender-inbox, but guard)
    if (envelope.from === config.agentId) return;

    logger.info(`[AgentLink] Message from ${envelope.from_name} (${envelope.from}): ${envelope.type}`);

    for (const handler of messageHandlers) {
      handler(envelope);
    }
  }

  return {
    async start() {
      client.onMessage(handleIncoming);
      await client.connect();
      // Subscribe to our inbox: all messages addressed to us
      await client.subscribe(TOPICS.inboxAll(config.agentId));
      logger.info(`[AgentLink] Listening on inbox: ${TOPICS.inboxAll(config.agentId)}`);
    },

    async stop() {
      await client.disconnect();
    },

    getClient() {
      return client;
    },

    onMessage(handler) {
      messageHandlers.push(handler);
    },

    isConnected() {
      return client.isConnected();
    },
  };
}
