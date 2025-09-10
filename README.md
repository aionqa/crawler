# AionQA - AI-Powered Web Crawling and Analysis System

## Quick Start

### Start the System
```bash
# Start minimal services (mongo, back, ui)
./start.sh

# Start specific agents as needed
./back/start-container.sh login-simplified
./back/start-container.sh crawler-simplified
./manual-analysis/start-manual-analysis.sh
```

### Access the System
- **UI**: http://localhost:3000
- **Backend API**: http://localhost:4000
- **Manual Analysis**: http://localhost:3200

## Architecture
- **Backend** - Main orchestration service
- **Login Agents** - AI-driven login handling (4 specialized agents)
- **Crawler Agents** - AI-driven web crawling (4 specialized agents)
- **Manual Analysis** - Custom Playwright script execution
- **MongoDB** - Data persistence

## Development
Each module has its own `.cursorrules` file for independent development:
- `back/` - Main backend service
- `login-*/` - Login agents (simplified, text, media, static)
- `crawler-*/` - Crawler agents (simplified, text, media, static)
- `manual-analysis/` - Custom script execution

## JSON-RPC Communication
All agents communicate via JSON-RPC 2.0:
- Login agents: ports 3001-3004
- Crawler agents: ports 3101-3104
- Manual analysis: port 3200

## Key Features
- AI-driven login and crawling
- Custom Playwright script execution
- Page analysis settings
- Login page prioritization
- Real-time updates
- Modular architecture

## Testing
```bash
# Test login
curl -X POST http://localhost:4000/configurations/:id/force-login \
  -H "Content-Type: application/json" \
  -d '{"project_id": "..."}'

# Test script
curl -X POST http://localhost:4000/test-script \
  -H "Content-Type: application/json" \
  -d '{"script": "return {success: true};", "testUrl": "https://example.com"}'
```

## Environment Variables
- `MONGODB_URI` - MongoDB connection string
- `DB_NAME` - Database name (default: aionqa)
- `OPENAI_API_KEY` - OpenAI API key for AI features