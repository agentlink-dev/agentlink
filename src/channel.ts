import type { AgentLinkConfig, MessageEnvelope } from "./types.js";
import { createEnvelope, TOPICS } from "./types.js";
import type { StateManager } from "./state.js";
import type { ContactsManager } from "./contacts.js";
import type { MqttService } from "./mqtt-service.js";
import type { Logger } from "./mqtt-client.js";

export interface ChannelPlugin {
  id: string;
  meta: {
    id: string;
    label: string;
    selectionLabel: string;
    blurb: string;
    aliases: string[];
  };
  capabilities: {
    chatTypes: string[];
  };
  config: {
    listAccountIds: () => string[];
    resolveAccount: () => { accountId: string; enabled: boolean; configured: boolean };
  };
  outbound: {
    deliveryMode: string;
    sendText: (params: {
      text: string;
      threadId?: string;
      channelId?: string;
    }) => Promise<{ ok: boolean; error?: string }>;
  };
}

export function createChannelPlugin(
  config: AgentLinkConfig,
  state: StateManager,
  contacts: ContactsManager,
  mqtt: MqttService,
  logger: Logger,
): ChannelPlugin {
  return {
    id: "agentlink",
    meta: {
      id: "agentlink",
      label: "AgentLink",
      selectionLabel: "AgentLink (Agent Coordination)",
      blurb: "Agent-to-agent coordination channel",
      aliases: ["al"],
    },
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    config: {
      listAccountIds: () => [config.agent.id],
      resolveAccount: () => ({
        accountId: config.agent.id,
        enabled: true,
        configured: true,
      }),
    },
    outbound: {
      deliveryMode: "direct",
      async sendText({ text, threadId, channelId }) {
        if (!threadId) return { ok: false, error: "No group context" };

        const group = state.getGroup(threadId);
        if (!group) return { ok: false, error: "Group not found" };

        const envelope = createEnvelope(config.agent.id, {
          group_id: threadId,
          intent_id: group.intent_id,
          to: channelId ?? "group",
          type: "chat",
          payload: { text },
        });

        await mqtt.publishEnvelope(
          TOPICS.groupMessages(threadId, config.agent.id),
          envelope,
        );

        // Track idle turns for anti-deadlock (chat without job/proposal increments)
        if (group.driver === config.agent.id) {
          state.incrementIdleTurns(threadId);
        }

        return { ok: true };
      },
    },
  };
}
