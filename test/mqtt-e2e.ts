import { resolveConfig } from "../src/types.js";
import { createMqttClient } from "../src/mqtt-client.js";

const config = resolveConfig({});
console.log("Resolved broker URL:", config.brokerUrl);
console.log("Resolved agent ID:", config.agent.id);

const logger = {
  info: (m: string) => console.log(m),
  warn: (m: string) => console.log("WARN:", m),
  error: (m: string) => console.log("ERROR:", m),
};

const testTopic = "agentlink/test/" + Date.now();
const testPayload = JSON.stringify({ test: true, ts: new Date().toISOString() });

const sender = createMqttClient(
  resolveConfig({ brokerUrl: config.brokerUrl, agent: { id: "test-sender" } }),
  logger,
);
const receiver = createMqttClient(
  resolveConfig({ brokerUrl: config.brokerUrl, agent: { id: "test-receiver" } }),
  logger,
);

async function run() {
  console.log("\n--- Connecting sender ---");
  await sender.connect();
  console.log("Sender connected:", sender.isConnected());

  console.log("\n--- Connecting receiver ---");
  await receiver.connect();
  console.log("Receiver connected:", receiver.isConnected());

  let received = false;
  receiver.onMessage((topic, payload) => {
    console.log("\n--- RECEIVED ---");
    console.log("Topic:", topic);
    console.log("Payload:", payload.toString());
    received = true;
  });

  await receiver.subscribe(testTopic);
  console.log("\nReceiver subscribed to:", testTopic);

  // Let subscription propagate
  await new Promise((r) => setTimeout(r, 500));

  console.log("\nSender publishing...");
  await sender.publish(testTopic, testPayload);
  console.log("Published:", testPayload);

  // Wait for delivery
  await new Promise((r) => setTimeout(r, 2000));

  if (received) {
    console.log("\n=== PASS: Message sent and received ===");
  } else {
    console.log("\n=== FAIL: Message not received ===");
  }

  await sender.disconnect();
  await receiver.disconnect();
  process.exit(received ? 0 : 1);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
