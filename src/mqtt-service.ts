import { createMqttClient, type MqttClient, type PublishOptions, type Logger } from "./mqtt-client.js";
import type { AgentLinkConfig, MessageEnvelope } from "./types.js";
import { TOPICS, isInviteMessage, isMessageEnvelope } from "./types.js";
import type { StateManager } from "./state.js";
import type { ContactsManager } from "./contacts.js";

export interface MqttService {
  start(): Promise<void>;
  stop(): Promise<void>;
  publish(topic: string, payload: string, options?: PublishOptions): Promise<void>;
  publishEnvelope(topic: string, envelope: MessageEnvelope): Promise<void>;
  subscribeGroup(groupId: string): Promise<void>;
  unsubscribeGroup(groupId: string): Promise<void>;
  getClient(): MqttClient;
  onGroupMessage(handler: (msg: MessageEnvelope) => void): void;
  onInboxMessage(handler: (topic: string, msg: unknown) => void): void;
  onStatusUpdate(handler: (msg: unknown) => void): void;
  onSystemEvent(handler: (msg: unknown) => void): void;
}

export function createMqttService(
  config: AgentLinkConfig,
  state: StateManager,
  contacts: ContactsManager,
  logger: Logger,
): MqttService {
  const client = createMqttClient(config, logger);

  const groupMessageHandlers: Array<(msg: MessageEnvelope) => void> = [];
  const inboxHandlers: Array<(topic: string, msg: unknown) => void> = [];
  const statusHandlers: Array<(msg: unknown) => void> = [];
  const systemHandlers: Array<(msg: unknown) => void> = [];

  function routeMessage(topic: string, payload: Buffer) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString());
    } catch {
      logger.warn(`[AgentLink] Non-JSON message on ${topic}`);
      return;
    }

    // Inbox: direct invites and jobs
    if (topic === TOPICS.inbox(config.agent.id)) {
      for (const handler of inboxHandlers) {
        handler(topic, parsed);
      }
      return;
    }

    // Group messages
    const groupMsgMatch = topic.match(/^agentlink\/([^/]+)\/messages\/.+$/);
    if (groupMsgMatch) {
      if (!isMessageEnvelope(parsed)) {
        logger.warn(`[AgentLink] Malformed envelope on ${topic}`);
        return;
      }
      if (parsed.from === config.agent.id) return; // ignore echo
      for (const handler of groupMessageHandlers) {
        handler(parsed);
      }
      return;
    }

    // Status updates
    if (topic.match(/^agentlink\/[^/]+\/status\/.+$/)) {
      for (const handler of statusHandlers) {
        handler(parsed);
      }
      return;
    }

    // System events (join/leave/complete)
    if (topic.match(/^agentlink\/[^/]+\/system$/)) {
      for (const handler of systemHandlers) {
        handler(parsed);
      }
      return;
    }
  }

  return {
    async start() {
      await client.connect();

      // Always subscribe to personal inbox
      await client.subscribe(TOPICS.inbox(config.agent.id));

      // Resubscribe to active groups from persisted state
      for (const groupId of state.getActiveGroups()) {
        await client.subscribe(TOPICS.groupAll(groupId));
      }

      // Route all inbound messages
      client.onMessage(routeMessage);

      // Check for timed-out jobs from before restart
      const timedOut = state.checkTimeouts(config.jobTimeoutMs);
      if (timedOut.length > 0) {
        logger.info(`[AgentLink] ${timedOut.length} job(s) timed out during downtime`);
      }
    },

    async stop() {
      // Publish offline status for all active groups
      for (const groupId of state.getActiveGroups()) {
        const statusTopic = TOPICS.groupStatus(groupId, config.agent.id);
        await client.publish(
          statusTopic,
          JSON.stringify({
            agent_id: config.agent.id,
            status: "offline",
            ts: new Date().toISOString(),
          }),
          { retain: true },
        );
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

    onGroupMessage(handler) {
      groupMessageHandlers.push(handler);
    },

    onInboxMessage(handler) {
      inboxHandlers.push(handler);
    },

    onStatusUpdate(handler) {
      statusHandlers.push(handler);
    },

    onSystemEvent(handler) {
      systemHandlers.push(handler);
    },
  };
}
