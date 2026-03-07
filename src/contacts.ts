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
  let contacts: Record<string, ContactEntry> = {};

  if (fs.existsSync(filePath)) {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    contacts = raw.contacts ?? {};
  }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ contacts }, null, 2));
  }

  return {
    resolve(nameOrId) {
      if (contacts[nameOrId]) return contacts[nameOrId].agent_id;
      for (const entry of Object.values(contacts)) {
        if (entry.agent_id === nameOrId) return nameOrId;
      }
      return null;
    },

    add(name, agentId) {
      contacts[name] = {
        agent_id: agentId,
        added: new Date().toISOString().split("T")[0],
      };
      save();
    },

    remove(name) {
      delete contacts[name];
      save();
    },

    has(name) {
      return name in contacts;
    },

    getAll() {
      return { ...contacts };
    },

    getNameByAgentId(agentId) {
      for (const [name, entry] of Object.entries(contacts)) {
        if (entry.agent_id === agentId) return name;
      }
      return null;
    },
  };
}
