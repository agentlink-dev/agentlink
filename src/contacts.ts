import fs from "node:fs";
import path from "node:path";

export interface ContactEntry {
  agent_id: string;
  added: string;
}

export interface ContactsManager {
  resolve(nameOrId: string): string | null;
  add(name: string, agentId: string): void;
  remove(name: string): void;
  has(name: string): boolean;
  getAll(): Record<string, ContactEntry>;
  getNameByAgentId(agentId: string): string | null;
}

export function createContacts(dataDir: string): ContactsManager {
  const filePath = path.join(dataDir, "contacts.json");

  function load(): Record<string, ContactEntry> {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return raw.contacts ?? {};
    } catch {
      return {};
    }
  }

  function save(contacts: Record<string, ContactEntry>) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ contacts }, null, 2));
  }

  return {
    resolve(nameOrId) {
      const contacts = load();
      // Exact match
      if (contacts[nameOrId]) return contacts[nameOrId].agent_id;
      // Case-insensitive match on contact name
      const lower = nameOrId.toLowerCase();
      for (const [name, entry] of Object.entries(contacts)) {
        if (name.toLowerCase() === lower) return entry.agent_id;
      }
      // Exact match on agent_id
      for (const entry of Object.values(contacts)) {
        if (entry.agent_id === nameOrId) return nameOrId;
      }
      return null;
    },

    add(name, agentId) {
      const contacts = load();
      contacts[name] = {
        agent_id: agentId,
        added: new Date().toISOString().split("T")[0],
      };
      save(contacts);
    },

    remove(name) {
      const contacts = load();
      delete contacts[name];
      save(contacts);
    },

    has(name) {
      return name in load();
    },

    getAll() {
      return { ...load() };
    },

    getNameByAgentId(agentId) {
      for (const [name, entry] of Object.entries(load())) {
        if (entry.agent_id === agentId) return name;
      }
      return null;
    },
  };
}
