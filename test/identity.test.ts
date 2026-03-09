import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadIdentity, saveIdentity, ensureIdentity, resolveIdentity } from "../src/identity.js";

const TEST_DIR = path.join(os.tmpdir(), `agentlink-test-identity-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadIdentity", () => {
  it("returns null when no file exists", () => {
    expect(loadIdentity(TEST_DIR)).toBeNull();
  });

  it("loads valid identity", () => {
    const identity = { agent_id: "test-1234", human_name: "TestUser" };
    fs.writeFileSync(path.join(TEST_DIR, "identity.json"), JSON.stringify(identity));
    expect(loadIdentity(TEST_DIR)).toEqual(identity);
  });

  it("returns null for invalid JSON", () => {
    fs.writeFileSync(path.join(TEST_DIR, "identity.json"), "not json");
    expect(loadIdentity(TEST_DIR)).toBeNull();
  });

  it("returns null for missing fields", () => {
    fs.writeFileSync(path.join(TEST_DIR, "identity.json"), JSON.stringify({ agent_id: "x" }));
    expect(loadIdentity(TEST_DIR)).toBeNull();
  });
});

describe("saveIdentity", () => {
  it("writes identity to disk", () => {
    const identity = { agent_id: "test-abcd", human_name: "Alice" };
    saveIdentity(identity, TEST_DIR);
    const loaded = JSON.parse(fs.readFileSync(path.join(TEST_DIR, "identity.json"), "utf-8"));
    expect(loaded.agent_id).toBe("test-abcd");
    expect(loaded.human_name).toBe("Alice");
  });

  it("creates directory if needed", () => {
    const nested = path.join(TEST_DIR, "nested", "dir");
    const identity = { agent_id: "test-1234", human_name: "Bob" };
    saveIdentity(identity, nested);
    expect(fs.existsSync(path.join(nested, "identity.json"))).toBe(true);
  });
});

describe("ensureIdentity", () => {
  it("creates identity on fresh install", () => {
    const identity = ensureIdentity("Rupul", TEST_DIR);
    expect(identity.human_name).toBe("Rupul");
    expect(identity.agent_id).toMatch(/^rupul-[a-z0-9]{4}$/);
    // Verify persisted
    expect(loadIdentity(TEST_DIR)).toEqual(identity);
  });

  it("returns existing identity if present", () => {
    const first = ensureIdentity("Rupul", TEST_DIR);
    const second = ensureIdentity("Different", TEST_DIR);
    expect(second).toEqual(first); // Should not regenerate
  });
});

describe("resolveIdentity", () => {
  it("uses explicit config when both provided", () => {
    const identity = resolveIdentity({
      agentId: "custom-id",
      humanName: "Custom",
      dataDir: TEST_DIR,
    });
    expect(identity.agent_id).toBe("custom-id");
    expect(identity.human_name).toBe("Custom");
  });

  it("falls back to disk identity", () => {
    saveIdentity({ agent_id: "disk-1234", human_name: "DiskUser" }, TEST_DIR);
    const identity = resolveIdentity({ dataDir: TEST_DIR });
    expect(identity.agent_id).toBe("disk-1234");
    expect(identity.human_name).toBe("DiskUser");
  });

  it("auto-generates when nothing exists", () => {
    const identity = resolveIdentity({ dataDir: TEST_DIR });
    expect(identity.agent_id).toBeTruthy();
    expect(identity.human_name).toBeTruthy();
  });
});
