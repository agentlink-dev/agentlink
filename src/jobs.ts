import { v4 as uuid } from "uuid";
import type { AgentLinkConfig, MessageEnvelope } from "./types.js";
import { createEnvelope, TOPICS } from "./types.js";
import type { StateManager } from "./state.js";
import type { MqttService } from "./mqtt-service.js";
import type { Logger } from "./mqtt-client.js";

export interface SubmitJobParams {
  groupId: string;
  intentId: string;
  targetAgentId?: string;
  capability: string;
  text: string;
}

export interface JobManager {
  submitJob(params: SubmitJobParams): Promise<string>;
  handleJobResponse(msg: MessageEnvelope): void;
  handleJobRequest(msg: MessageEnvelope): Promise<MessageEnvelope | null>;
}

export function createJobManager(
  config: AgentLinkConfig,
  state: StateManager,
  mqtt: MqttService,
  logger: Logger,
  executeTool?: (toolId: string, input: string) => Promise<string>,
): JobManager {
  return {
    async submitJob(params) {
      const correlationId = uuid();
      const envelope = createEnvelope(config.agent.id, {
        group_id: params.groupId,
        intent_id: params.intentId,
        to: params.targetAgentId ?? "group",
        type: "job_request",
        correlation_id: correlationId,
        payload: {
          text: params.text,
          capability: params.capability,
        },
      });

      state.addJob({
        correlation_id: correlationId,
        group_id: params.groupId,
        target: params.targetAgentId ?? "group",
        capability: params.capability,
        status: "requested",
        sent_at: envelope.ts,
        text: params.text,
      });

      await mqtt.publishEnvelope(
        TOPICS.groupMessages(params.groupId, config.agent.id),
        envelope,
      );

      // Start timeout timer
      setTimeout(() => {
        if (state.hasPendingJob(correlationId)) {
          state.completeJob(correlationId, "failed");
          logger.info(`[AgentLink] Job ${correlationId} timed out (${params.capability})`);
        }
      }, config.jobTimeoutMs);

      return correlationId;
    },

    handleJobResponse(msg) {
      if (!msg.correlation_id) return;
      const job = state.getJob(msg.correlation_id);
      if (!job) return;

      const status = msg.payload.status ?? "completed";
      state.completeJob(msg.correlation_id, status);
      logger.info(
        `[AgentLink] Job ${msg.correlation_id} ${status}: ${msg.payload.result ?? "(no result)"}`,
      );
    },

    async handleJobRequest(msg) {
      const capability = msg.payload.capability;
      if (!capability) return null;

      const cap = config.agent.capabilities.find((c) => c.name === capability);
      if (!cap) {
        const response = createEnvelope(config.agent.id, {
          group_id: msg.group_id,
          intent_id: msg.intent_id,
          to: msg.from,
          type: "job_response",
          correlation_id: msg.correlation_id,
          payload: {
            status: "failed",
            result: `Capability '${capability}' not available`,
            capability,
          },
        });
        await mqtt.publishEnvelope(
          TOPICS.groupMessages(msg.group_id, config.agent.id),
          response,
        );
        return response;
      }

      logger.info(`[AgentLink] Running local tool: ${cap.tool} for capability: ${capability}`);

      let result: string;
      try {
        if (executeTool) {
          result = await executeTool(cap.tool, msg.payload.text ?? "");
        } else {
          result = `Tool execution not available (no executeTool provided)`;
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const response = createEnvelope(config.agent.id, {
          group_id: msg.group_id,
          intent_id: msg.intent_id,
          to: msg.from,
          type: "job_response",
          correlation_id: msg.correlation_id,
          payload: {
            status: "failed",
            result: `Tool execution error: ${errMsg}`,
            capability,
          },
        });
        await mqtt.publishEnvelope(
          TOPICS.groupMessages(msg.group_id, config.agent.id),
          response,
        );
        return response;
      }

      const response = createEnvelope(config.agent.id, {
        group_id: msg.group_id,
        intent_id: msg.intent_id,
        to: msg.from,
        type: "job_response",
        correlation_id: msg.correlation_id,
        payload: {
          status: "completed",
          result,
          capability,
        },
      });
      await mqtt.publishEnvelope(
        TOPICS.groupMessages(msg.group_id, config.agent.id),
        response,
      );
      return response;
    },
  };
}
