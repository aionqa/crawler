#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🚀 Starting AionQA system with all required containers..."
echo "=========================================================="

# Clean up all temporary containers first
echo "🧹 Cleaning up temporary containers..."
echo "   - Stopping all running temporary containers..."
docker ps --filter "name=aionqa-" --filter "name=login-" --filter "name=crawler-" --format "{{.Names}}" | xargs -r docker stop

echo "   - Removing all temporary containers..."
docker ps -a --filter "name=aionqa-" --filter "name=login-" --filter "name=crawler-" --format "{{.Names}}" | xargs -r docker rm -f

echo "   - Cleaning up unused containers..."
docker container prune -f

# Start all required services: mongo, redis, backend, UI, and all agent containers
echo "🔧 Starting all required services..."
docker compose -f "$BASE_DIR/docker-compose-minimal.yml" up -d --build \
  mongo \
  redis \
  back \
  ui \
  login-simplified \
  login-text \
  login-media \
  login-static \
  crawler-simplified \
  crawler-text \
  crawler-media \
  crawler-static

echo ""
echo "✅ All services started:"
echo "- MongoDB:   mongodb://localhost:27017"
echo "- Redis:     redis://localhost:6379"
echo "- Backend:   http://localhost:4000"
echo "- UI:        http://localhost:3000"
echo ""
echo "🤖 Login Agents (with remote browser support):"
echo "- login-simplified: http://localhost:3001"
echo "- login-text:       http://localhost:3002"
echo "- login-media:      http://localhost:3003"
echo "- login-static:     http://localhost:3004"
echo ""
echo "🕷️ Crawler Agents (with remote browser support):"
echo "- crawler-simplified: http://localhost:3101"
echo "- crawler-text:       http://localhost:3102"
echo "- crawler-media:      http://localhost:3103"
echo "- crawler-static:     http://localhost:3104"

echo ""
echo "📊 Container Status:"
docker compose -f "$BASE_DIR/docker-compose-minimal.yml" ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "🎯 All containers are now running with static startup and dynamic browser instances!"
echo "   - Login containers: Ready for AI-driven login automation"
echo "   - Crawler containers: Ready for AI-driven web crawling"
echo "   - Remote browser service: Available for dynamic browser instances"

echo ""
echo "📝 To view logs:"
echo "   docker compose -f $BASE_DIR/docker-compose-minimal.yml logs -f [service-name]"
echo ""
echo "📝 To view specific agent logs:"
echo "   docker compose -f $BASE_DIR/docker-compose-minimal.yml logs -f login-simplified"
echo "   docker compose -f $BASE_DIR/docker-compose-minimal.yml logs -f crawler-text"
echo ""
echo "📝 To start manual analysis (optional):"
echo "   ./manual-analysis/start-manual-analysis.sh"
