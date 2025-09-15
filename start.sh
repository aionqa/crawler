#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🚀 Starting minimal AionQA setup (essential services only)..."
echo "=========================================================="

# Clean up all temporary containers first
echo "🧹 Cleaning up temporary containers..."
echo "   - Stopping all running temporary containers..."
docker ps --filter "name=aionqa-" --filter "name=login-" --filter "name=crawler-" --format "{{.Names}}" | xargs -r docker stop

echo "   - Removing all temporary containers..."
docker ps -a --filter "name=aionqa-" --filter "name=login-" --filter "name=crawler-" --format "{{.Names}}" | xargs -r docker rm -f

echo "   - Cleaning up unused containers..."
docker container prune -f

# Start only essential services: mongo, redis, backend, and UI
echo "🔧 Starting essential services..."
docker compose -f "$BASE_DIR/docker-compose-minimal.yml" up -d --build \
  mongo \
  redis \
  back \
  ui

echo ""
echo "✅ Essential services started:"
echo "- MongoDB:   mongodb://localhost:27017"
echo "- Redis:     redis://localhost:6379"
echo "- Backend:   http://localhost:4000"
echo "- UI:        http://localhost:3000"

echo ""
echo "📊 Container Status:"
docker compose -f "$BASE_DIR/docker-compose-minimal.yml" ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "🎯 Login and Crawler containers will start automatically when needed!"
echo "   - Login containers: login-simplified, login-text, login-media, login-static"
echo "   - Crawler containers: crawler-simplified, crawler-text, crawler-media, crawler-static"

echo ""
echo "📝 To view logs:"
echo "   docker compose -f $BASE_DIR/docker-compose-minimal.yml logs -f [service-name]"

echo ""
echo "📝 To start specific agents:"
echo "   ./start-container.sh <agent-name>"
echo "   ./start-manual-analysis.sh"
