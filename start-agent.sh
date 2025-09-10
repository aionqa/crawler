#!/usr/bin/env bash
set -euo pipefail

# Script to start agent containers on demand
# Usage: ./start-agent.sh <agent-type> [project-id]

AGENT_TYPE="$1"
PROJECT_ID="${2:-default}"

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🚀 Starting agent container: $AGENT_TYPE for project: $PROJECT_ID"

# Start the specific agent container
docker compose -f "$BASE_DIR/docker-compose-minimal.yml" up -d --build "$AGENT_TYPE"

echo "✅ Agent container started: $AGENT_TYPE"

# Wait a moment for container to be ready
sleep 3

echo "🎯 Container $AGENT_TYPE is ready for project $PROJECT_ID"
