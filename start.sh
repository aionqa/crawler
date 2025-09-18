#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🚀 Starting AionQA system with all required containers..."
echo "=========================================================="

# Clean up all temporary containers first
echo "🧹 Cleaning up temporary containers..."
echo "   - Stopping all running temporary containers..."
docker ps --filter "name=aionqa-" --filter "name=login-" --filter "name=crawler-" --filter "name=browser-" --format "{{.Names}}" | xargs -r docker stop

echo "   - Removing all temporary containers..."
docker ps -a --filter "name=aionqa-" --filter "name=login-" --filter "name=crawler-" --filter "name=browser-" --format "{{.Names}}" | xargs -r docker rm -f

echo "   - Cleaning up unused containers..."
docker container prune -f

# Start all required services: redis, backend, UI, and all agent containers
echo "🔧 Starting all required services..."
docker compose -f "$BASE_DIR/docker-compose.yml" up -d --build \
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

# Start Graylog logging appliance (includes MongoDB)
echo "📊 Starting Graylog logging appliance with MongoDB..."
docker compose -f "$BASE_DIR/docker-compose-graylog.yml" up -d

# Wait for MongoDB and Graylog to be ready
echo "⏳ Waiting for MongoDB and Graylog to initialize..."
sleep 30

# Start Portainer (Container Management UI)
echo "🖥️ Starting Portainer container management..."
docker compose -f "$BASE_DIR/docker-compose-portainer.yml" up -d

# Start browser containers using the browsers profile
echo "🌐 Starting dedicated browser containers (5 instances)..."
docker compose -f "$BASE_DIR/docker-compose.yml" --profile browsers up -d browser-1 browser-2 browser-3 browser-4 browser-5

echo ""
echo "✅ All services started:"
echo "- MongoDB:   mongodb://localhost:27017"
echo "- Redis:     redis://localhost:6379"
echo "- Backend:   http://localhost:4000"
echo "- UI:        http://localhost:3000"
echo "- Graylog:   http://localhost:9000 (admin/admin)"
echo "- Portainer: http://localhost:9001 (container management)"
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
echo "🌐 Dedicated Browser Containers:"
echo "- aionqa-browser-1: http://localhost:9222"
echo "- aionqa-browser-2: http://localhost:9223"
echo "- aionqa-browser-3: http://localhost:9224"
echo "- aionqa-browser-4: http://localhost:9225"
echo "- aionqa-browser-5: http://localhost:9226"

echo ""
echo "📊 Container Status:"
docker compose -f "$BASE_DIR/docker-compose.yml" ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "📊 Graylog Status:"
docker compose -f "$BASE_DIR/docker-compose-graylog.yml" ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "🎯 All containers are now running with dedicated browser instances!"
echo "   - Login containers: Ready for AI-driven login automation"
echo "   - Crawler containers: Ready for AI-driven web crawling"
echo "   - Dedicated browser containers: 5 browser instances available"

echo ""
echo "📝 To view logs:"
echo "   docker compose -f $BASE_DIR/docker-compose.yml logs -f [service-name]"
echo ""
echo "📝 To view specific agent logs:"
echo "   docker compose -f $BASE_DIR/docker-compose.yml logs -f login-simplified"
echo "   docker compose -f $BASE_DIR/docker-compose.yml logs -f crawler-text"
echo ""
echo "📝 To start manual analysis (optional):"
echo "   ./manual-analysis/start-manual-analysis.sh"
