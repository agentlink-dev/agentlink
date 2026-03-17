import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createContacts } from "../src/contacts.js";

const TEST_DIR = path.join(os.tmpdir(), `agentlink-test-contacts-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ContactsStore", () => {
  it("starts empty", () => {
    const contacts = createContacts(TEST_DIR);
    expect(contacts.getAll()).toEqual({});
  });

  it("adds and retrieves contacts", () => {
    const contacts = createContacts(TEST_DIR);
    contacts.add("sarah", "brienne-4m2p", "Sarah");
    expect(contacts.has("sarah")).toBe(true);
    expect(contacts.resolve("sarah")).toBe("brienne-4m2p");
  });

  it("resolves case-insensitively", () => {
    const contacts = createContacts(TEST_DIR);
    contacts.add("sarah", "brienne-4m2p");
    expect(contacts.resolve("Sarah")).toBe("brienne-4m2p");
    expect(contacts.resolve("SARAH")).toBe("brienne-4m2p");
  });

  it("resolves by agent ID directly", () => {
    const contacts = createContacts(TEST_DIR);
    contacts.add("sarah", "brienne-4m2p");
    expect(contacts.resolve("brienne-4m2p")).toBe("brienne-4m2p");
  });

  it("returns null for unknown contacts", () => {
    const contacts = createContacts(TEST_DIR);
    expect(contacts.resolve("nobody")).toBeNull();
  });

  it("supports aliases (multiple names → same agent)", () => {
    const contacts = createContacts(TEST_DIR);
    contacts.add("sarah", "brienne-4m2p", "Sarah");
    contacts.add("cathy", "brienne-4m2p", "Sarah");
    expect(contacts.resolve("sarah")).toBe("brienne-4m2p");
    expect(contacts.resolve("cathy")).toBe("brienne-4m2p");
  });

  it("removes contacts", () => {
    const contacts = createContacts(TEST_DIR);
    contacts.add("sarah", "brienne-4m2p");
    expect(contacts.remove("sarah")).toBe(true);
    expect(contacts.has("sarah")).toBe(false);
    expect(contacts.resolve("sarah")).toBeNull();
  });

  it("remove returns false for non-existent contact", () => {
    const contacts = createContacts(TEST_DIR);
    expect(contacts.remove("nobody")).toBe(false);
  });

  it("gets full contact entry", () => {
    const contacts = createContacts(TEST_DIR);
    contacts.add("sarah", "brienne-4m2p", "Sarah");
    const entry = contacts.get("sarah");
    expect(entry).toBeTruthy();
    expect(entry!.agent_id).toBe("brienne-4m2p");
    expect(entry!.human_name).toBe("Sarah");
    expect(entry!.added).toBeTruthy();
  });

  it("finds by agent ID", () => {
    const contacts = createContacts(TEST_DIR);
    contacts.add("sarah", "brienne-4m2p", "Sarah");
    const found = contacts.findByAgentId("brienne-4m2p");
    expect(found).toBeTruthy();
    expect(found!.name).toBe("sarah");
  });

  it("findByAgentId returns null if not found", () => {
    const contacts = createContacts(TEST_DIR);
    expect(contacts.findByAgentId("unknown-1234")).toBeNull();
  });

  it("persists across instances", () => {
    const c1 = createContacts(TEST_DIR);
    c1.add("sarah", "brienne-4m2p");
    const c2 = createContacts(TEST_DIR);
    expect(c2.resolve("sarah")).toBe("brienne-4m2p");
  });
});
