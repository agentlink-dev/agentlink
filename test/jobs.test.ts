import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createJobManager } from "../src/jobs.js";
import { createState } from "../src/state.js";
import { createEnvelope } from "../src/types.js";
import type { AgentLinkConfig, MessageEnvelope } from "../src/types.js";
import type { MqttService } from "../src/mqtt-service.js";

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeConfig(overrides: Partial<AgentLinkConfig> = {}): AgentLinkConfig {
  return {
    brokerUrl: "mqtt://localhost:1883",
    agent: {
      id: "agent-a",
      capabilities: [
        { name: "check_calendar", tool: "cal.check" },
        { name: "read_files", tool: "files.list" },
      ],
    },
    outputMode: "debug",
    jobTimeoutMs: 500, // short for tests
    dataDir: "/tmp",
    ...overrides,
  };
}

function makeMockMqtt(): MqttService & { published: Array<{ topic: string; envelope: MessageEnvelope }> } {
  const published: Array<{ topic: string; envelope: MessageEnvelope }> = [];
  return {
    published,
    async start() {},
    async stop() {},
    async publish() {},
    async publishEnvelope(topic, envelope) {
      published.push({ topic, envelope });
    },
    async subscribeGroup() {},
    async unsubscribeGroup() {},
    getClient: () => ({} as any),
    onGroupMessage() {},
    onInboxMessage() {},
    onStatusUpdate() {},
    onSystemEvent() {},
  };
}

describe("jobs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-jobs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("submitJob publishes envelope and tracks in state", async () => {
    const state = createState(tmpDir);
    const mqtt = makeMockMqtt();
    const jobs = createJobManager(makeConfig(), state, mqtt, noopLogger);

    const correlationId = await jobs.submitJob({
      groupId: "g1",
      intentId: "i1",
      capability: "check_calendar",
      text: "Saturday availability",
    });

    expect(correlationId).toBeTruthy();
    expect(state.hasPendingJob(correlationId)).toBe(true);
    expect(mqtt.published).toHaveLength(1);
    expect(mqtt.published[0].envelope.type).toBe("job_request");
    expect(mqtt.published[0].envelope.payload.capability).toBe("check_calendar");
  });

  it("submitJob with explicit target sets 'to' field", async () => {
    const state = createState(tmpDir);
    const mqtt = makeMockMqtt();
    const jobs = createJobManager(makeConfig(), state, mqtt, noopLogger);

    await jobs.submitJob({
      groupId: "g1",
      intentId: "i1",
      targetAgentId: "agent-b",
      capability: "check_calendar",
      text: "Saturday availability",
    });

    expect(mqtt.published[0].envelope.to).toBe("agent-b");
  });

  it("handleJobResponse completes the pending job", async () => {
    const state = createState(tmpDir);
    const mqtt = makeMockMqtt();
    const jobs = createJobManager(makeConfig(), state, mqtt, noopLogger);

    const correlationId = await jobs.submitJob({
      groupId: "g1",
      intentId: "i1",
      capability: "check_calendar",
      text: "Saturday availability",
    });

    const response = createEnvelope("agent-b", {
      group_id: "g1",
      to: "agent-a",
      type: "job_response",
      correlation_id: correlationId,
      payload: { status: "completed", result: "Free 6-10pm" },
    });

    jobs.handleJobResponse(response);
    expect(state.hasPendingJob(correlationId)).toBe(false);
    expect(state.getJob(correlationId)!.status).toBe("completed");
  });

  it("handleJobRequest with matching capability calls executeTool", async () => {
    const state = createState(tmpDir);
    const mqtt = makeMockMqtt();
    const executeTool = vi.fn().mockResolvedValue("file1.txt, file2.txt");
    const jobs = createJobManager(makeConfig(), state, mqtt, noopLogger, executeTool);

    const request = createEnvelope("agent-b", {
      group_id: "g1",
      to: "agent-a",
      type: "job_request",
      correlation_id: "req-1",
      payload: { text: "list files", capability: "read_files" },
    });

    const response = await jobs.handleJobRequest(request);
    expect(executeTool).toHaveBeenCalledWith("files.list", "list files");
    expect(response).not.toBeNull();
    expect(response!.payload.status).toBe("completed");
    expect(response!.payload.result).toBe("file1.txt, file2.txt");
  });

  it("handleJobRequest with unknown capability returns failed", async () => {
    const state = createState(tmpDir);
    const mqtt = makeMockMqtt();
    const jobs = createJobManager(makeConfig(), state, mqtt, noopLogger);

    const request = createEnvelope("agent-b", {
      group_id: "g1",
      to: "agent-a",
      type: "job_request",
      correlation_id: "req-1",
      payload: { text: "do something", capability: "nonexistent" },
    });

    const response = await jobs.handleJobRequest(request);
    expect(response!.payload.status).toBe("failed");
    expect(response!.payload.result).toContain("not available");
  });

  it("handleJobRequest with tool error returns failed", async () => {
    const state = createState(tmpDir);
    const mqtt = makeMockMqtt();
    const executeTool = vi.fn().mockRejectedValue(new Error("tool crashed"));
    const jobs = createJobManager(makeConfig(), state, mqtt, noopLogger, executeTool);

    const request = createEnvelope("agent-b", {
      group_id: "g1",
      to: "agent-a",
      type: "job_request",
      correlation_id: "req-1",
      payload: { text: "list files", capability: "read_files" },
    });

    const response = await jobs.handleJobRequest(request);
    expect(response!.payload.status).toBe("failed");
    expect(response!.payload.result).toContain("tool crashed");
  });

  it("job times out and is marked failed", async () => {
    const state = createState(tmpDir);
    const mqtt = makeMockMqtt();
    const config = makeConfig({ jobTimeoutMs: 200 });
    const jobs = createJobManager(config, state, mqtt, noopLogger);

    const correlationId = await jobs.submitJob({
      groupId: "g1",
      intentId: "i1",
      capability: "check_calendar",
      text: "Saturday availability",
    });

    expect(state.hasPendingJob(correlationId)).toBe(true);

    // Wait for timeout
    await new Promise((r) => setTimeout(r, 400));

    expect(state.hasPendingJob(correlationId)).toBe(false);
    expect(state.getJob(correlationId)!.status).toBe("failed");
  });
});
