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

      return new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          cleanup();
          logger.info(`[AgentLink] Connected to broker: ${config.brokerUrl}`);
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          logger.error(`[AgentLink] MQTT error: ${err.message}`);
          reject(err);
        };
        function cleanup() {
          client!.removeListener("connect", onConnect);
          client!.removeListener("error", onError);
        }

        client!.on("connect", onConnect);
        client!.on("error", onError);

        client!.on("message", (topic, payload) => {
          for (const handler of messageHandlers) {
            handler(topic, payload);
          }
        });

        client!.on("reconnect", () => {
          logger.info("[AgentLink] Reconnecting to broker...");
        });

        // Resubscribe on reconnect (clean:true means broker forgets subscriptions)
        client!.on("connect", () => {
          for (const topic of subscribedTopics) {
            client!.subscribe(topic, { qos: 1 });
          }
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
      if (!client) throw new Error("MQTT not connected");
      subscribedTopics.add(topic);
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
      if (!client) throw new Error("MQTT not connected");
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
