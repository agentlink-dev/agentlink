import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createContacts } from "../src/contacts.js";

describe("contacts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("add and resolve by name", () => {
    const contacts = createContacts(tmpDir);
    contacts.add("Sara", "sara-macbook");
    expect(contacts.resolve("Sara")).toBe("sara-macbook");
  });

  it("resolve by agent_id directly", () => {
    const contacts = createContacts(tmpDir);
    contacts.add("Sara", "sara-macbook");
    expect(contacts.resolve("sara-macbook")).toBe("sara-macbook");
  });

  it("resolve returns null for unknown", () => {
    const contacts = createContacts(tmpDir);
    expect(contacts.resolve("nobody")).toBeNull();
  });

  it("has checks name existence", () => {
    const contacts = createContacts(tmpDir);
    contacts.add("Sara", "sara-macbook");
    expect(contacts.has("Sara")).toBe(true);
    expect(contacts.has("Alex")).toBe(false);
  });

  it("remove deletes a contact", () => {
    const contacts = createContacts(tmpDir);
    contacts.add("Sara", "sara-macbook");
    contacts.remove("Sara");
    expect(contacts.resolve("Sara")).toBeNull();
    expect(contacts.has("Sara")).toBe(false);
  });

  it("getAll returns all contacts", () => {
    const contacts = createContacts(tmpDir);
    contacts.add("Sara", "sara-macbook");
    contacts.add("Alex", "alex-laptop");
    const all = contacts.getAll();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all.Sara.agent_id).toBe("sara-macbook");
    expect(all.Alex.agent_id).toBe("alex-laptop");
  });

  it("getNameByAgentId reverse lookup", () => {
    const contacts = createContacts(tmpDir);
    contacts.add("Sara", "sara-macbook");
    expect(contacts.getNameByAgentId("sara-macbook")).toBe("Sara");
    expect(contacts.getNameByAgentId("unknown")).toBeNull();
  });

  it("persists to disk and reloads", () => {
    const contacts1 = createContacts(tmpDir);
    contacts1.add("Sara", "sara-macbook");

    const contacts2 = createContacts(tmpDir);
    expect(contacts2.resolve("Sara")).toBe("sara-macbook");
  });

  it("loads pre-seeded contacts.json", () => {
    const seeded = {
      contacts: {
        "Agent B": { agent_id: "dev-agent-b", added: "2026-03-07" },
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, "contacts.json"),
      JSON.stringify(seeded),
    );

    const contacts = createContacts(tmpDir);
    expect(contacts.resolve("Agent B")).toBe("dev-agent-b");
  });
});
