#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🚀 Starting Manual Analysis Service"
echo "=================================="

# Start the manual analysis service
echo "🔧 Starting manual analysis service..."
docker compose -f "$BASE_DIR/docker-compose-minimal.yml" up -d --build manual-analysis

echo ""
echo "✅ Manual Analysis Service started successfully!"

echo ""
echo "📊 Container Status:"
docker compose -f "$BASE_DIR/docker-compose-minimal.yml" ps manual-analysis --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "🌐 Service URLs:"
echo "- Manual Analysis API: http://localhost:3200"
echo "- Health Check: http://localhost:3200/health"

echo ""
echo "📝 Available Endpoints:"
echo "- POST /analyze/:pageId - Analyze page with custom script"
echo "- GET /results/:pageId - Get analysis results for page"
echo "- GET /results - Get all analysis results"
echo "- POST /test-script - Test a custom script"

echo ""
echo "📝 To view logs:"
echo "   docker compose -f $BASE_DIR/docker-compose-minimal.yml logs -f manual-analysis"

echo ""
echo "📝 To stop service:"
echo "   docker compose -f $BASE_DIR/docker-compose-minimal.yml stop manual-analysis"
