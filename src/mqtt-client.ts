import mqtt from "mqtt";
import type { AgentLinkConfig } from "./types.js";

export interface PublishOptions {
  retain?: boolean;
  qos?: 0 | 1 | 2;
}

export interface MqttClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(topic: string): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
  publish(topic: string, payload: string | Buffer, options?: PublishOptions): Promise<void>;
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
  let subscribedTopics: Set<string> = new Set();

  return {
    async connect() {
      client = mqtt.connect(config.brokerUrl, {
        username: config.brokerUsername,
        password: config.brokerPassword,
        clientId: `agentlink-${config.agent.id}-${Date.now()}`,
        clean: true,
        keepalive: 30,
        reconnectPeriod: 5000,
        connectTimeout: 10_000,
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
          // Resubscribe on every connect (clean:true means broker forgets subscriptions)
          for (const topic of subscribedTopics) {
            client!.subscribe(topic, { qos: 1 });
          }
        });

        client!.on("error", (err: Error) => {
          if (!resolved) {
            // First connection attempt failed — start anyway, mqtt.js will keep retrying
            resolved = true;
            logger.warn(`[AgentLink] Broker unavailable (${err.message}), will retry in background`);
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
        subscribedTopics.clear();
        await new Promise<void>((resolve) => client!.end(false, {}, () => resolve()));
        client = null;
      }
    },

    async subscribe(topic) {
      if (!client) throw new Error("MQTT client not initialized");
      subscribedTopics.add(topic);
      // If not connected, the topic is tracked and will be subscribed on (re)connect
      if (!client.connected) return;
      return new Promise<void>((resolve, reject) => {
        client!.subscribe(topic, { qos: 1 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    async unsubscribe(topic) {
      if (!client) throw new Error("MQTT not connected");
      subscribedTopics.delete(topic);
      return new Promise<void>((resolve, reject) => {
        client!.unsubscribe(topic, {}, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    async publish(topic, payload, options = {}) {
      if (!client) throw new Error("MQTT client not initialized");
      if (!client.connected) throw new Error("MQTT broker not connected (retrying in background)");
      return new Promise<void>((resolve, reject) => {
        client!.publish(
          topic,
          payload,
          { qos: options.qos ?? 1, retain: options.retain ?? false },
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
