# CLI Implementation TODO

## ✅ Completed (Committed)

1. **Type System** - All interfaces updated with email, phone, location:
   - `Identity`, `AgentStatus`, `AgentLinkConfig`, `ContactEntry`
   - `createStatusPayload()` accepts email, phone, location
   - `resolveIdentity()` merges email, phone, location

2. **Data Layer**:
   - `loadIdentity()` reads email, phone, location from identity.json
   - `saveIdentity()` preserves new fields
   - Tested with test-identity.js ✓

3. **MQTT Layer**:
   - Status topic publishes full profile (email, phone, location)
   - LWT includes contact info

4. **Contacts**:
   - `ContactEntry` stores email, phone, location
   - `contacts.add()` accepts new parameters

## 🚧 Remaining CLI Work (bin/cli.js)

### 1. Argument Parsing (lines ~2210-2230)

```javascript
// ADD after line 2223:
const emailIdx = args.indexOf("--email");
const emailArg = emailIdx >= 0 ? args[emailIdx + 1] : undefined;

const phoneIdx = args.indexOf("--phone");
const phoneArg = phoneIdx >= 0 ? args[phoneIdx + 1] : undefined;

const locationIdx = args.indexOf("--location");
const locationArg = locationIdx >= 0 ? args[locationIdx + 1] : undefined;

const jsonIdx = args.indexOf("--json");
const jsonOutput = jsonIdx >= 0;

// UPDATE line 2225:
setup(joinCode, humanNameArg, agentNameArg, emailArg, phoneArg, locationArg, jsonOutput);
```

### 2. Setup Function Signature (line 261)

```javascript
// UPDATE:
async function setup(joinCode, humanNameArg, agentNameArg, emailArg, phoneArg, locationArg, jsonOutput) {
```

### 3. Setup Function - Non-Interactive Mode (lines ~288-310)

```javascript
// ADD variables after line 289:
let email;
let phone;
let location;

// UPDATE isNonInteractive check (line ~291):
const isNonInteractive = humanNameArg || agentNameArg || emailArg || joinCode;

// ADD in non-interactive block after agentName assignment:
email = emailArg || detected.email;
phone = phoneArg || detected.phone;
location = locationArg || detected.location;

if (emailArg) {
  console.log(pc.dim(`  Email: ${email} (from --email)`));
} else if (detected.email) {
  console.log(pc.dim(`  Email: ${email} (from identity.json)`));
}

if (phoneArg) {
  console.log(pc.dim(`  Phone: ${phone} (from --phone)`));
}

if (locationArg) {
  console.log(pc.dim(`  Location: ${location} (from --location)`));
}
```

### 4. Setup Function - Interactive Mode (lines ~310-360)

```javascript
// ADD after agentName prompt (~line 350):
if (detected.email) {
  console.log(pc.dim(`\n  Detected email: ${pc.bold(detected.email)}`));
  const answer = await ask(`  Email (press Enter to confirm, or type to change): `);
  email = answer || detected.email;
} else {
  email = await ask("\n  Email (for discovery, required): ");
}

if (!email) {
  console.error(pc.red("  Email is required for discovery.\n"));
  process.exit(1);
}

// Optional fields
if (detected.phone) {
  console.log(pc.dim(`\n  Detected phone: ${pc.bold(detected.phone)}`));
  const answer = await ask(`  Phone (press Enter to skip or confirm, or type to change): `);
  phone = answer || detected.phone;
} else {
  phone = await ask("\n  Phone (optional, press Enter to skip): ");
}

if (detected.location) {
  console.log(pc.dim(`\n  Detected location: ${pc.bold(detected.location)}`));
  const answer = await ask(`  Location (press Enter to skip or confirm, or type to change): `);
  location = answer || detected.location;
} else {
  location = await ask("\n  Location (optional, e.g. 'Amsterdam, Netherlands', press Enter to skip): ");
}
```

### 5. Setup Function - Identity Creation (line ~360)

```javascript
// UPDATE identity object creation:
const agentId = `${slugify(agentName)}-${generateSuffix()}`;
identity = {
  agent_id: agentId,
  human_name: humanName,
  agent_name: agentName,
  email,
  phone,
  location
};
fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2) + "\n");

// ADD after identity creation:
console.log(pc.green(`  ✓ Agent ID: ${agentId}`));
console.log(pc.dim(`  ${agentName} for ${humanName}`));
if (email) console.log(pc.dim(`  Email: ${email}`));
if (phone) console.log(pc.dim(`  Phone: ${phone}`));
if (location) console.log(pc.dim(`  Location: ${location}`));
```

### 6. Setup Function - Auto-Publish (after plugin installation, ~line 450)

```javascript
// ADD after plugin installation success:
if (identity.email) {
  const spinner = ora("Publishing email to discovery directory...").start();
  try {
    await publishToDirectory(identity.email);
    spinner.succeed(`Published: ${identity.email}`);
  } catch (err) {
    spinner.fail(`Failed to publish email: ${err.message}`);
  }
}

if (identity.phone) {
  const spinner = ora("Publishing phone to discovery directory...").start();
  try {
    await publishToDirectory(identity.phone);
    spinner.succeed(`Published: ${identity.phone}`);
  } catch (err) {
    spinner.fail(`Failed to publish phone: ${err.message}`);
  }
}
```

### 7. Setup Function - JSON Output (end of function)

```javascript
// ADD at end of setup function before final console.log:
if (jsonOutput) {
  const output = {
    status: detected?.existing ? "updated" : "created",
    agent_id: identity.agent_id,
    human_name: identity.human_name,
    agent_name: identity.agent_name,
    email: identity.email,
    phone: identity.phone,
    location: identity.location,
    published: []
  };

  if (identity.email) output.published.push(identity.email);
  if (identity.phone) output.published.push(identity.phone);

  console.log(JSON.stringify(output, null, 2));
  return;
}
```

### 8. Connect Command - Full Profile from Whois (lines ~1000-1100)

Already implemented! The whois query returns full profile including email, phone, location.

Just need to update contacts.add() call to pass these fields:

```javascript
// UPDATE contacts.add() call in connectToAgent function:
contacts.add(
  contactName,
  agentProfile.agent_id,
  agentProfile.human_name,
  agentProfile.capabilities,
  agentProfile.agent_name,
  agentProfile.email,      // ADD
  agentProfile.phone,      // ADD
  agentProfile.location    // ADD
);
```

### 9. Help Text (lines ~2286-2320)

```javascript
// UPDATE setup command help:
console.log("    " + pc.cyan("agentlink setup [--join CODE] [--human-name NAME] [--agent-name NAME] [--email EMAIL] [--phone PHONE] [--location LOCATION] [--json]"));
console.log("      Set up AgentLink and optionally join with an invite code");

// UPDATE examples:
console.log("    " + pc.cyan("agentlink setup --human-name \"Alice\" --agent-name \"Ally\" --email alice@example.com"));
console.log("    " + pc.cyan("agentlink setup --email bob@example.com --phone +12025551234 --location \"NYC\" --json"));
```

## Testing Checklist

After implementing CLI changes:

- [ ] `agentlink setup` interactive mode prompts for email (required)
- [ ] `agentlink setup` interactive mode prompts for phone/location (optional)
- [ ] `agentlink setup --email alice@example.com` non-interactive works
- [ ] `agentlink setup --json` outputs valid JSON
- [ ] Auto-publishes email after setup
- [ ] Auto-publishes phone if provided
- [ ] `agentlink connect` stores full profile (email, phone, location)
- [ ] OpenClaw agent can call `agentlink setup --email ... --json` and parse output
- [ ] Idempotent: re-running setup updates only changed fields

## Validation

Run after implementation:
```bash
# Test non-interactive setup
AGENTLINK_DATA_DIR=/tmp/test-al node bin/cli.js setup \
  --human-name "Test User" \
  --agent-name "TestBot" \
  --email test@example.com \
  --phone +12025551234 \
  --location "San Francisco" \
  --json

# Verify identity.json
cat /tmp/test-al/identity.json

# Test discovery
node bin/cli.js search test@example.com

# Clean up
rm -rf /tmp/test-al
```
