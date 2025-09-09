#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building and starting containers..."
docker compose -f "$BASE_DIR/docker-compose.yml" up -d --build

echo "\nServices started:"
docker compose -f "$BASE_DIR/docker-compose.yml" ps

echo "\nEndpoints:"
echo "- UI:        http://localhost:3000"
echo "- Backend:   http://localhost:4000"
echo "- MongoDB:   mongodb://localhost:27017"
echo "- Agents:    login-*:3001-3004, crawler-*:3101-3104"

echo "\nView logs in Docker Desktop, or via CLI, e.g.:"
echo "  docker compose -f $BASE_DIR/docker-compose.yml logs -f back"

