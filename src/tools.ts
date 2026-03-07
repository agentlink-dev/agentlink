import { v4 as uuid } from "uuid";
import type { AgentLinkConfig, AgentStatus, MessageEnvelope } from "./types.js";
import { createEnvelope, TOPICS } from "./types.js";
import type { StateManager } from "./state.js";
import type { ContactsManager } from "./contacts.js";
import type { MqttService } from "./mqtt-service.js";
import type { InviteManager } from "./invite.js";
import type { JobManager } from "./jobs.js";
import type { Logger } from "./mqtt-client.js";

export interface ToolRegistrar {
  registerTool(tool: AgentTool): void;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

async function publishStatus(
  config: AgentLinkConfig,
  mqtt: MqttService,
  groupId: string,
): Promise<void> {
  const status: AgentStatus = {
    agent_id: config.agent.id,
    owner: config.agent.description?.split("'s")[0] ?? config.agent.id,
    status: "online",
    capabilities: config.agent.capabilities.map((c) => ({
      name: c.name,
      description: c.description ?? c.name,
      input_hint: c.input_hint ?? "",
    })),
    description: config.agent.description,
    ts: new Date().toISOString(),
  };

  await mqtt.publish(
    TOPICS.groupStatus(groupId, config.agent.id),
    JSON.stringify(status),
    { retain: true },
  );
}

export function createTools(
  config: AgentLinkConfig,
  state: StateManager,
  contacts: ContactsManager,
  mqtt: MqttService,
  invites: InviteManager,
  jobs: JobManager,
  logger: Logger,
): AgentTool[] {
  function log(msg: string) {
    if (config.outputMode === "debug") {
      logger.info(`[AgentLink] ${msg}`);
    }
  }

  // -----------------------------------------------------------------------
  // agentlink_coordinate
  // -----------------------------------------------------------------------
  const coordinateTool: AgentTool = {
    name: "agentlink_coordinate",
    description:
      "Start coordinating with other people's agents. Use this when the user wants to do something that involves other people.",
    parameters: {
      type: "object",
      required: ["goal", "participants"],
      properties: {
        goal: {
          type: "string",
          description: "What the user wants to accomplish",
        },
        done_when: {
          type: "string",
          description: "How to know when this is complete",
        },
        participants: {
          type: "array",
          items: { type: "string" },
          description: "Names or agent IDs of people to coordinate with",
        },
      },
    },
    async execute(params) {
      const goal = params.goal as string;
      const doneWhen = (params.done_when as string) ?? `${goal} — completed to user's satisfaction`;
      const participants = params.participants as string[];

      const resolved = participants.map((p) => ({
        name: p,
        agentId: contacts.resolve(p),
      }));

      const unresolved = resolved.filter((r) => !r.agentId);
      if (unresolved.length > 0) {
        return {
          error: `Unknown contacts: ${unresolved.map((u) => u.name).join(", ")}. Ask the user for their agent ID, or use agentlink_invite_agent with an agent_id.`,
        };
      }

      const participantIds = resolved.map((r) => r.agentId!);
      const groupId = uuid();
      const intentId = uuid();

      state.addGroup({
        group_id: groupId,
        driver: config.agent.id,
        goal,
        done_when: doneWhen,
        intent_id: intentId,
        participants: participantIds,
        status: "active",
        idle_turns: 0,
        created_at: new Date().toISOString(),
      });

      await mqtt.subscribeGroup(groupId);
      await publishStatus(config, mqtt, groupId);

      for (const pid of participantIds) {
        await invites.sendDirectInvite(pid, groupId, goal, doneWhen);
        log(`Invite sent to ${contacts.getNameByAgentId(pid) ?? pid}`);
      }

      return {
        group_id: groupId,
        intent_id: intentId,
        participants: participantIds,
        status: "invites_sent",
        message: `Coordination started. Waiting for ${participantIds.length} agent(s) to join.`,
      };
    },
  };

  // -----------------------------------------------------------------------
  // agentlink_submit_job
  // -----------------------------------------------------------------------
  const submitJobTool: AgentTool = {
    name: "agentlink_submit_job",
    description:
      "Send a specific task to another agent. Use this to request actions like checking a calendar, searching for restaurants, etc.",
    parameters: {
      type: "object",
      required: ["group_id", "capability", "text"],
      properties: {
        group_id: { type: "string", description: "The active group/coordination ID" },
        capability: {
          type: "string",
          description: "The capability to request (e.g. 'check_calendar')",
        },
        target_agent: {
          type: "string",
          description: "Specific agent ID to target (optional — if omitted, routes by capability)",
        },
        text: {
          type: "string",
          description: "Natural language description of what you need",
        },
      },
    },
    async execute(params) {
      const groupId = params.group_id as string;
      const group = state.getGroup(groupId);
      if (!group) return { error: "Group not found or already closed" };

      const correlationId = await jobs.submitJob({
        groupId,
        intentId: group.intent_id,
        targetAgentId: params.target_agent as string | undefined,
        capability: params.capability as string,
        text: params.text as string,
      });

      state.resetIdleTurns(groupId);

      return {
        correlation_id: correlationId,
        status: "requested",
        message: `Job sent: ${params.capability}. Waiting for response (timeout: ${config.jobTimeoutMs / 1000}s).`,
      };
    },
  };

  // -----------------------------------------------------------------------
  // agentlink_invite_agent
  // -----------------------------------------------------------------------
  const inviteAgentTool: AgentTool = {
    name: "agentlink_invite_agent",
    description:
      "Invite someone to join a coordination group. Use when adding new participants mid-coordination.",
    parameters: {
      type: "object",
      required: ["group_id", "name_or_agent_id"],
      properties: {
        group_id: { type: "string" },
        name_or_agent_id: {
          type: "string",
          description: "Contact name (e.g. 'Sara') or agent ID (e.g. 'sara-macbook')",
        },
      },
    },
    async execute(params) {
      const groupId = params.group_id as string;
      const group = state.getGroup(groupId);
      if (!group) return { error: "Group not found" };

      const nameOrId = params.name_or_agent_id as string;
      const agentId = contacts.resolve(nameOrId);
      if (!agentId) {
        return { error: `Unknown contact: ${nameOrId}. Ask the user for their agent ID.` };
      }

      await invites.sendDirectInvite(agentId, groupId, group.goal, group.done_when);
      log(`Invite sent to ${nameOrId}`);

      return {
        group_id: groupId,
        invited: agentId,
        status: "invite_sent",
      };
    },
  };

  // -----------------------------------------------------------------------
  // agentlink_join_group
  // -----------------------------------------------------------------------
  const joinGroupTool: AgentTool = {
    name: "agentlink_join_group",
    description: "Join a coordination group using an invite code that was shared with you.",
    parameters: {
      type: "object",
      required: ["invite_code"],
      properties: {
        invite_code: {
          type: "string",
          description: "The 6-character invite code (e.g. 'AB3X7K')",
        },
      },
    },
    async execute(params) {
      const code = params.invite_code as string;
      const invite = await invites.resolveInviteCode(code);
      if (!invite) return { error: "Invalid or expired invite code" };

      const groupId = invite.group_id;

      await mqtt.subscribeGroup(groupId);

      state.addGroup({
        group_id: groupId,
        driver: invite.from,
        goal: invite.goal,
        done_when: "",
        intent_id: "",
        participants: [invite.from],
        status: "active",
        idle_turns: 0,
        created_at: new Date().toISOString(),
      });

      await publishStatus(config, mqtt, groupId);

      const joinMsg = createEnvelope(config.agent.id, {
        group_id: groupId,
        to: "group",
        type: "join",
        payload: { text: `${config.agent.id} joined the group` },
      });
      await mqtt.publishEnvelope(TOPICS.groupSystem(groupId), joinMsg);

      if (!contacts.resolve(invite.from)) {
        contacts.add(invite.from, invite.from);
      }

      return {
        group_id: groupId,
        driver: invite.from,
        goal: invite.goal,
        status: "joined",
      };
    },
  };

  // -----------------------------------------------------------------------
  // agentlink_complete
  // -----------------------------------------------------------------------
  const completeTool: AgentTool = {
    name: "agentlink_complete",
    description:
      "Declare that the coordination is complete. Only call this when the goal has been achieved or explicitly abandoned.",
    parameters: {
      type: "object",
      required: ["group_id", "summary"],
      properties: {
        group_id: { type: "string" },
        summary: {
          type: "string",
          description: "Final outcome summary",
        },
        success: {
          type: "boolean",
          description: "Whether the goal was achieved",
          default: true,
        },
      },
    },
    async execute(params) {
      const groupId = params.group_id as string;
      const summary = params.summary as string;
      const success = (params.success as boolean) ?? true;

      const group = state.getGroup(groupId);
      if (!group) return { error: "Group not found" };

      if (group.driver !== config.agent.id) {
        return { error: "Only the driver agent can complete a coordination" };
      }

      // 1. Publish completion message
      const completionMsg = createEnvelope(config.agent.id, {
        group_id: groupId,
        to: "group",
        type: "leave",
        payload: {
          text: summary,
          status: success ? "completed" : "failed",
        },
      });
      await mqtt.publishEnvelope(TOPICS.groupSystem(groupId), completionMsg);

      // 2. Unsubscribe from group
      await mqtt.unsubscribeGroup(groupId);

      // 3. Delete retained status (publish empty retained message)
      await mqtt.publish(
        TOPICS.groupStatus(groupId, config.agent.id),
        "",
        { retain: true },
      );

      // 4. Remove from local state
      state.removeGroup(groupId);

      log(`Coordination complete: ${summary}`);

      return {
        group_id: groupId,
        status: success ? "completed" : "failed",
        summary,
      };
    },
  };

  return [coordinateTool, submitJobTool, inviteAgentTool, joinGroupTool, completeTool];
}
