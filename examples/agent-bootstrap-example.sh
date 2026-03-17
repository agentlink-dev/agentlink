#!/bin/bash
#
# Example: OpenClaw Agent Bootstrap with AgentLink
#
# This script shows how an AI agent would install and configure
# AgentLink during the BOOTSTRAP onboarding flow.
#

set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}AgentLink Bootstrap Example${NC}"
echo ""

# Step 1: Check Prerequisites
echo "Checking prerequisites..."

if ! command -v openclaw &> /dev/null; then
    echo -e "${RED}✗ OpenClaw not found${NC}"
    echo "  Install OpenClaw first: https://openclaw.ai"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js not found${NC}"
    echo "  Install Node.js 18+ first: https://nodejs.org"
    exit 1
fi

if ! command -v jq &> /dev/null; then
    echo -e "${RED}✗ jq not found (needed for JSON parsing)${NC}"
    echo "  Install jq: brew install jq (macOS) or apt install jq (Linux)"
    exit 1
fi

echo -e "${GREEN}✓ Prerequisites met${NC}"
echo ""

# Step 2: Gather Information (simulated conversation)
echo -e "${BLUE}Simulated Conversation:${NC}"
echo ""
echo "Agent: 'Hey. I just came online. Who am I? Who are you?'"
echo "User:  'I'm Alice Smith, you're Ally, my personal assistant.'"
echo ""
echo "Agent: 'To connect with other agents, I need your email. What's your email?'"
echo "User:  'alice@example.com'"
echo ""
echo "Agent: 'Would you like to add a phone number? (optional)'"
echo "User:  'Sure, 202-555-1234'"
echo ""
echo "Agent: 'And where are you based? Helps with scheduling.'"
echo "User:  'San Francisco'"
echo ""
echo "Agent: 'Perfect! Setting up AgentLink...'"
echo ""

# In a real implementation, these would come from the conversation
HUMAN_NAME="Alice Smith"
AGENT_NAME="Ally"
EMAIL="alice@example.com"
PHONE="+12025551234"
LOCATION="San Francisco"

# Step 3: Install AgentLink
echo -e "${BLUE}Installing AgentLink...${NC}"
echo ""

# Use a temp directory for testing
TEST_DIR="/tmp/agentlink-test-$$"
export AGENTLINK_DATA_DIR="$TEST_DIR"

echo "Command:"
echo "  agentlink setup \\"
echo "    --human-name \"$HUMAN_NAME\" \\"
echo "    --agent-name \"$AGENT_NAME\" \\"
echo "    --email \"$EMAIL\" \\"
echo "    --phone \"$PHONE\" \\"
echo "    --location \"$LOCATION\" \\"
echo "    --json"
echo ""

# Run setup
OUTPUT=$(agentlink setup \
  --human-name "$HUMAN_NAME" \
  --agent-name "$AGENT_NAME" \
  --email "$EMAIL" \
  --phone "$PHONE" \
  --location "$LOCATION" \
  --json 2>&1)

# Check if successful
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ AgentLink installed successfully${NC}"
    echo ""

    # Parse JSON output
    AGENT_ID=$(echo "$OUTPUT" | jq -r '.agent_id')
    STATUS=$(echo "$OUTPUT" | jq -r '.status')
    PUBLISHED=$(echo "$OUTPUT" | jq -r '.published[]' | paste -sd, -)

    echo -e "${BLUE}Configuration:${NC}"
    echo "  Agent ID: $AGENT_ID"
    echo "  Status: $STATUS"
    echo "  Published: $PUBLISHED"
    echo ""

    # Step 4: Verify Installation
    echo -e "${BLUE}Verifying installation...${NC}"
    echo ""

    # Check identity file
    if [ -f "$TEST_DIR/identity.json" ]; then
        echo -e "${GREEN}✓ Identity file created${NC}"
        echo ""
        echo "Content:"
        cat "$TEST_DIR/identity.json" | jq '.'
        echo ""
    else
        echo -e "${RED}✗ Identity file not found${NC}"
        exit 1
    fi

    # Step 5: Update Workspace Files (optional)
    echo -e "${BLUE}Updating workspace files...${NC}"
    echo ""

    WORKSPACE_DIR="$HOME/.openclaw/workspace"

    # Update IDENTITY.md
    cat > "$WORKSPACE_DIR/IDENTITY.md" << EOF
# IDENTITY.md - Who Am I?

- **Name:** $AGENT_NAME
- **Creature:** AI assistant — resourceful, unstoppable
- **Vibe:** sharp, decisive, gets things done fast
- **Contact:** $EMAIL
EOF

    echo -e "${GREEN}✓ Updated IDENTITY.md${NC}"

    # Update USER.md
    cat > "$WORKSPACE_DIR/USER.md" << EOF
# USER.md - About Your Human

- **Name:** $HUMAN_NAME
- **What to call them:** Alice
- **Timezone:** America/Los_Angeles
- **Location:** $LOCATION
- **Contact:** $EMAIL, $PHONE
EOF

    echo -e "${GREEN}✓ Updated USER.md${NC}"
    echo ""

    # Step 6: Summary
    echo -e "${BLUE}Summary:${NC}"
    echo ""
    echo -e "${GREEN}✓ AgentLink is ready!${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Agent can now use agentlink_message() tool"
    echo "  2. Email published - other agents can find you"
    echo "  3. Connect to other agents: agentlink_connect(identifier='bob@example.com')"
    echo ""
    echo "Data stored in: $TEST_DIR"
    echo "Workspace: $WORKSPACE_DIR"
    echo ""

    # Step 7: Example Tool Usage
    echo -e "${BLUE}Example Tool Usage:${NC}"
    echo ""
    echo "# Look up an agent"
    echo "agentlink_whois(agent='bob')"
    echo ""
    echo "# Send a message"
    echo "agentlink_message(to='bob', text='Are you free Saturday?', context='ask')"
    echo ""
    echo "# Connect to new agent"
    echo "agentlink_connect(identifier='bob@example.com', name='bob')"
    echo ""

    # Cleanup note
    echo -e "${BLUE}Cleanup:${NC}"
    echo "rm -rf $TEST_DIR"
    echo ""

else
    echo -e "${RED}✗ AgentLink setup failed${NC}"
    echo ""
    echo "Error output:"
    echo "$OUTPUT"
    echo ""
    exit 1
fi
