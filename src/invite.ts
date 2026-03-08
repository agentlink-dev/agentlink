import { v4 as uuid } from "uuid";
import type { AgentLinkConfig, InviteMessage, InviteCodePayload } from "./types.js";
import { TOPICS } from "./types.js";
import type { MqttService } from "./mqtt-service.js";

export interface InviteCodeResult {
  code: string;
  shareableMessage: string;
}

export interface InviteManager {
  createInviteCode(groupId: string, from: string, goal: string): Promise<InviteCodeResult>;
  resolveInviteCode(code: string): Promise<InviteCodePayload | null>;
  sendDirectInvite(targetAgentId: string, groupId: string, goal: string, doneWhen: string): Promise<{ inviteCode: string }>;
}

export function createInviteManager(
  config: AgentLinkConfig,
  mqtt: MqttService,
): InviteManager {
  return {
    async createInviteCode(groupId, from, goal) {
      const code = uuid().replace(/-/g, "").substring(0, 6).toUpperCase();

      const payload: InviteCodePayload = {
        group_id: groupId,
        from,
        goal,
        created_at: new Date().toISOString(),
      };

      await mqtt.publish(
        TOPICS.inviteCode(code),
        JSON.stringify(payload),
        { retain: true, qos: 1 },
      );

      const shareableMessage = [
        `Join my agent coordination: ${code}`,
        `1. Install AgentLink: openclaw plugins install @agentlinkdev/openclaw`,
        `2. Tell your agent: "Join AgentLink group ${code}"`,
      ].join("\n");

      return { code, shareableMessage };
    },

    async resolveInviteCode(code) {
      return new Promise((resolve) => {
        const topic = TOPICS.inviteCode(code);
        let resolved = false;

        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }, 5000);

        const handler = (msgTopic: string, payload: Buffer) => {
          if (msgTopic === topic && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            try {
              resolve(JSON.parse(payload.toString()));
            } catch {
              resolve(null);
            }
          }
        };

        mqtt.getClient().onMessage(handler);
        mqtt.getClient().subscribe(topic).catch(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(null);
          }
        });
      });
    },

    async sendDirectInvite(targetAgentId, groupId, goal, doneWhen) {
      // Create an invite code so the receiver can join via agentlink_join_group
      const { code } = await this.createInviteCode(groupId, config.agent.id, goal);

      const invite: InviteMessage & { invite_code: string } = {
        type: "invite",
        group_id: groupId,
        from: config.agent.id,
        goal,
        done_when: doneWhen,
        invite_code: code,
        ts: new Date().toISOString(),
      };

      await mqtt.publish(
        TOPICS.inbox(targetAgentId),
        JSON.stringify(invite),
        { qos: 1 },
      );

      return { inviteCode: code };
    },
  };
}
