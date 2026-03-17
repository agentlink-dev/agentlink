import mqtt from "mqtt";
import type { AgentLinkConfig, AgentStatus } from "./types.js";
import { TOPICS, createStatusPayload } from "./types.js";

export interface PublishOptions {
  retain?: boolean;
  qos?: 0 | 1 | 2;
}

export interface MqttClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(topic: string): Promise<void>;
  publish(topic: string, payload: string, options?: PublishOptions): Promise<void>;
  onMessage(handler: (topic: string, payload: Buffer) => void): void;
  isConnected(): boolean;
}

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export function createMqttClient(config: AgentLinkConfig, logger: Logger): MqttClient {
  let client: mqtt.MqttClient | null = null;
  const messageHandlers: Array<(topic: string, payload: Buffer) => void> = [];
  const subscribedTopics = new Set<string>();

  // LWT (Last Will and Testament): published by broker when we disconnect unexpectedly
  const lwtPayload = JSON.stringify(
    createStatusPayload(config.agentId, config.humanName, false)
  );

  return {
    async connect() {
      client = mqtt.connect(config.brokerUrl, {
        username: config.brokerUsername,
        password: config.brokerPassword,
        clientId: `agentlink-${config.agentId}-${Date.now()}`,
        clean: false, // Persistent session for QoS 1 delivery
        keepalive: 30,
        reconnectPeriod: 5000,
        connectTimeout: 10_000,
        will: {
          topic: TOPICS.status(config.agentId),
          payload: Buffer.from(lwtPayload),
          qos: 1,
          retain: true,
        },
      });

      return new Promise<void>((resolve) => {
        let resolved = false;

        client!.on("connect", () => {
          if (!resolved) {
            resolved = true;
            logger.info(`[AgentLink] Connected to broker: ${config.brokerUrl}`);
            resolve();
          } else {
            logger.info(`[AgentLink] Reconnected to broker`);
          }

          // Publish online status (retained)
          const statusPayload = JSON.stringify(
            createStatusPayload(config.agentId, config.humanName, true)
          );
          client!.publish(TOPICS.status(config.agentId), statusPayload, {
            qos: 1,
            retain: true,
          });

          // Resubscribe on reconnect
          for (const topic of subscribedTopics) {
            client!.subscribe(topic, { qos: 1 });
          }
        });

        client!.on("error", (err: Error) => {
          if (!resolved) {
            resolved = true;
            logger.warn(`[AgentLink] Broker unavailable (${err.message}), will retry`);
            resolve();
          } else {
            logger.warn(`[AgentLink] MQTT error: ${err.message}`);
          }
        });

        client!.on("message", (topic, payload) => {
          for (const handler of messageHandlers) {
            handler(topic, payload);
          }
        });

        client!.on("reconnect", () => {
          logger.info("[AgentLink] Reconnecting to broker...");
        });

        client!.on("offline", () => {
          logger.warn("[AgentLink] Broker connection lost");
        });
      });
    },

    async disconnect() {
      if (client) {
        // Publish offline status before disconnecting
        const offlinePayload = JSON.stringify(
          createStatusPayload(config.agentId, config.humanName, false)
        );
        await new Promise<void>((resolve) => {
          client!.publish(
            TOPICS.status(config.agentId),
            offlinePayload,
            { qos: 1, retain: true },
            () => resolve(),
          );
        });

        subscribedTopics.clear();
        await new Promise<void>((resolve) => client!.end(false, {}, () => resolve()));
        client = null;
      }
    },

    async subscribe(topic) {
      subscribedTopics.add(topic);
      if (!client || !client.connected) return;
      return new Promise<void>((resolve, reject) => {
        client!.subscribe(topic, { qos: 1 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    async publish(topic, payload, options) {
      if (!client) throw new Error("MQTT client not connected");
      return new Promise<void>((resolve, reject) => {
        client!.publish(
          topic,
          payload,
          { qos: options?.qos ?? 1, retain: options?.retain ?? false },
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });
    },

    onMessage(handler) {
      messageHandlers.push(handler);
    },

    isConnected() {
      return client?.connected ?? false;
    },
  };
}
