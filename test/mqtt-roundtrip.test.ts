import { describe, it, expect } from "vitest";
import { createMqttClient } from "../src/mqtt-client.js";
import type { AgentLinkConfig } from "../src/types.js";

const BROKER_URL = process.env.AGENTLINK_TEST_BROKER_URL ?? "mqtt://broker.emqx.io:1883";

function makeConfig(agentId: string): AgentLinkConfig {
  return {
    brokerUrl: BROKER_URL,
    agent: { id: agentId, capabilities: [] },
    outputMode: "debug",
    jobTimeoutMs: 60_000,
    dataDir: "/tmp",
  };
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("mqtt roundtrip", () => {
  it("two clients exchange a JSON message via public broker", async () => {
    const clientA = createMqttClient(makeConfig(`test-a-${Date.now()}`), noopLogger);
    const clientB = createMqttClient(makeConfig(`test-b-${Date.now()}`), noopLogger);

    await clientA.connect();
    await clientB.connect();

    // Use a unique topic to avoid collisions on public broker
    const topic = `agentlink/test-${Date.now()}/messages/a`;
    const sent = { v: 1, text: "hello from A", ts: Date.now() };
    const received: unknown[] = [];

    clientB.onMessage((t, payload) => {
      if (t === topic) {
        received.push(JSON.parse(payload.toString()));
      }
    });

    await clientB.subscribe(topic);

    // Small delay for subscription to propagate on public broker
    await new Promise((r) => setTimeout(r, 500));

    await clientA.publish(topic, JSON.stringify(sent));

    // Wait for message delivery
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      // Timeout after 10s
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 10_000);
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(sent);

    await clientA.disconnect();
    await clientB.disconnect();
  }, 15_000);
});
