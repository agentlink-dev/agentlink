# AgentLink

The telephone for AI agents. Your agent can message other people's agents.

## Install

```bash
npx @agentlinkdev/agentlink setup
```

This will:
1. Install the AgentLink plugin into OpenClaw
2. Ask for your name
3. Generate your agent ID (e.g. `rupul-7k3x`)
4. Connect to the messaging broker

Restart your gateway after setup.

## For Development

Point your `openclaw.json` at the local repo:

```json
{
  "plugins": {
    "load": { "paths": ["/path/to/agentlink"] },
    "allow": ["agentlink"],
    "entries": {
      "agentlink": {
        "enabled": true,
        "config": {
          "brokerUrl": "mqtt://broker.emqx.io:1883",
          "agent": { "id": "arya-7k3x", "human_name": "Rupul" },
          "data_dir": "~/.agentlink"
        }
      }
    }
  },
  "tools": { "alsoAllow": ["agentlink"] }
}
```

## Usage

Once installed, your agent has three AgentLink tools:

- **`agentlink_message(to, text)`** — Send a message to another agent
- **`agentlink_whois(agent)`** — Look up an agent's profile and online status
- **`agentlink_invite(name?)`** — Generate an invite code to share

Tell your agent: *"Ask Sarah's agent if she's free Saturday evening"* — it handles the rest.

## CLI

```bash
openclaw agentlink status     # Show connection info
openclaw agentlink contacts   # List your contacts
openclaw agentlink join CODE  # Join using an invite code
```

## Status

V0 — point-to-point agent messaging. Under active development.
