import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createState } from "../src/state.js";
import type { GroupState, PendingJob } from "../src/types.js";

function makeGroup(overrides: Partial<GroupState> = {}): GroupState {
  return {
    group_id: "test-group-1",
    driver: "agent-a",
    goal: "Plan dinner",
    done_when: "restaurant booked",
    intent_id: "intent-1",
    participants: ["agent-b"],
    status: "active",
    idle_turns: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeJob(overrides: Partial<PendingJob> = {}): PendingJob {
  return {
    correlation_id: "job-1",
    group_id: "test-group-1",
    target: "agent-b",
    capability: "check_calendar",
    status: "requested",
    sent_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("state", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-state-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("groups", () => {
    it("add and get a group", () => {
      const state = createState(tmpDir);
      const group = makeGroup();
      state.addGroup(group);
      expect(state.getGroup("test-group-1")).toEqual(group);
    });

    it("getGroup returns null for missing", () => {
      const state = createState(tmpDir);
      expect(state.getGroup("nope")).toBeNull();
    });

    it("removeGroup deletes group and its jobs", () => {
      const state = createState(tmpDir);
      state.addGroup(makeGroup());
      state.addJob(makeJob());
      state.removeGroup("test-group-1");
      expect(state.getGroup("test-group-1")).toBeNull();
      expect(state.getJob("job-1")).toBeNull();
    });

    it("getActiveGroups filters by status", () => {
      const state = createState(tmpDir);
      state.addGroup(makeGroup({ group_id: "g1", status: "active" }));
      state.addGroup(makeGroup({ group_id: "g2", status: "closing" }));
      expect(state.getActiveGroups()).toEqual(["g1"]);
    });

    it("updateGroup merges updates", () => {
      const state = createState(tmpDir);
      state.addGroup(makeGroup());
      state.updateGroup("test-group-1", { goal: "New goal" });
      expect(state.getGroup("test-group-1")!.goal).toBe("New goal");
    });

    it("incrementIdleTurns and resetIdleTurns", () => {
      const state = createState(tmpDir);
      state.addGroup(makeGroup());
      expect(state.incrementIdleTurns("test-group-1")).toBe(1);
      expect(state.incrementIdleTurns("test-group-1")).toBe(2);
      expect(state.incrementIdleTurns("test-group-1")).toBe(3);
      state.resetIdleTurns("test-group-1");
      expect(state.getGroup("test-group-1")!.idle_turns).toBe(0);
    });

    it("incrementIdleTurns returns 0 for missing group", () => {
      const state = createState(tmpDir);
      expect(state.incrementIdleTurns("nope")).toBe(0);
    });
  });

  describe("jobs", () => {
    it("add and get a job", () => {
      const state = createState(tmpDir);
      const job = makeJob();
      state.addJob(job);
      expect(state.getJob("job-1")).toEqual(job);
    });

    it("hasPendingJob checks status", () => {
      const state = createState(tmpDir);
      state.addJob(makeJob());
      expect(state.hasPendingJob("job-1")).toBe(true);
      state.completeJob("job-1", "completed");
      expect(state.hasPendingJob("job-1")).toBe(false);
    });

    it("removeJob deletes job", () => {
      const state = createState(tmpDir);
      state.addJob(makeJob());
      state.removeJob("job-1");
      expect(state.getJob("job-1")).toBeNull();
    });

    it("getJobsForGroup returns matching jobs", () => {
      const state = createState(tmpDir);
      state.addJob(makeJob({ correlation_id: "j1", group_id: "g1" }));
      state.addJob(makeJob({ correlation_id: "j2", group_id: "g1" }));
      state.addJob(makeJob({ correlation_id: "j3", group_id: "g2" }));
      expect(state.getJobsForGroup("g1")).toHaveLength(2);
      expect(state.getJobsForGroup("g2")).toHaveLength(1);
    });

    it("checkTimeouts marks old jobs as failed", () => {
      const state = createState(tmpDir);
      const oldJob = makeJob({
        correlation_id: "old-job",
        sent_at: new Date(Date.now() - 120_000).toISOString(),
      });
      const freshJob = makeJob({
        correlation_id: "fresh-job",
        sent_at: new Date().toISOString(),
      });
      state.addJob(oldJob);
      state.addJob(freshJob);

      const timedOut = state.checkTimeouts(60_000);
      expect(timedOut).toHaveLength(1);
      expect(timedOut[0].correlation_id).toBe("old-job");
      expect(timedOut[0].timed_out).toBe(true);
      expect(state.getJob("old-job")!.status).toBe("failed");
      expect(state.getJob("fresh-job")!.status).toBe("requested");
    });
  });

  describe("persistence", () => {
    it("survives reload", () => {
      const state1 = createState(tmpDir);
      state1.addGroup(makeGroup());
      state1.addJob(makeJob());

      const state2 = createState(tmpDir);
      expect(state2.getGroup("test-group-1")).not.toBeNull();
      expect(state2.getJob("job-1")).not.toBeNull();
    });
  });
});
