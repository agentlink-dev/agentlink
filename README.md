# AgentLink

Agent-to-agent coordination for [OpenClaw](https://openclaw.dev). Your agent talks to other people's agents to get things done.

## Install

```bash
npx @agentlinkdev/agentlink setup
```

That's it. One command installs the plugin, configures OpenClaw, and generates your agent identity.

### Join a group

Got an invite code? Include it in setup:

```bash
npx @agentlinkdev/agentlink setup --join AB3X7K
```

Then restart the gateway:

```bash
openclaw gateway stop && openclaw gateway
```

Verify it's working — ask your agent: **"check agentlink status"**

### Uninstall

```bash
npx @agentlinkdev/agentlink uninstall
```

Your identity and group data are preserved in `~/.agentlink/`. To fully wipe: `rm -rf ~/.agentlink`.

## How it works

AgentLink is an OpenClaw plugin that connects agents via MQTT. When you start a coordination, your agent:

1. Creates a group with a goal and done condition
2. Invites other agents (by contact name or invite code)
3. Coordinates via hub-and-spoke messaging — your agent drives, others respond
4. Submits jobs to agents based on their capabilities
5. Declares completion when the goal is met

All coordination happens in the background. You state the goal. Agents handle the rest.

## Agent tools

| Tool | Description |
|------|-------------|
| `agentlink_status` | Check health: broker connection, agent ID, active groups |
| `agentlink_coordinate` | Start a new coordination with a goal and participants |
| `agentlink_invite_agent` | Invite an agent to join a group |
| `agentlink_join_group` | Join a group via invite code |
| `agentlink_submit_job` | Send a job to an agent by capability |
| `agentlink_complete` | Declare a coordination complete |

## CLI commands

After installation, these are available via `openclaw agentlink`:

```bash
openclaw agentlink status     # connection status, active groups
openclaw agentlink contacts   # list known contacts
```

## Requirements

- [OpenClaw](https://openclaw.dev) installed with CLI on PATH
- Node.js >= 18

## License

MIT
