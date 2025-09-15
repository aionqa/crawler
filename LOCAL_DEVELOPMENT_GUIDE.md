# AionQA - Local Development Guide

This guide explains how to work with each login-* and crawler-* repository locally for development and testing.

## Overview

Each agent repository now includes standardized local testing capabilities that allow you to:
- Test agents directly without Docker containers
- Debug with visual browser automation
- Test JSON-RPC endpoints locally
- Work on each repository independently

## Repository Structure

Each agent repository contains:
- `test-local.js` - Direct function testing script
- `test-rpc.js` - JSON-RPC endpoint testing script  
- `README-LOCAL.md` - Repository-specific local development guide
- `.cursorrules` - Updated with local development context

## Quick Start

### 1. Choose a Repository
Navigate to any agent repository:
```bash
cd login-simplified    # or login-text, login-media, login-static
cd crawler-simplified  # or crawler-text, crawler-media, crawler-static
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Set Environment Variables
```bash
export OPENAI_API_KEY="your-openai-api-key"
export MONGODB_URI="mongodb://localhost:27017"
export DB_NAME="aionqa"
```

### 4. Run Local Tests
```bash
# Direct function test
node test-local.js

# JSON-RPC endpoint test (requires server running)
npm start  # in another terminal
node test-rpc.js
```

## Login Agents

### Available Login Agents
- **login-simplified**: AI-driven login with multiple approaches
- **login-text**: Text-focused login handling
- **login-media**: Media-rich login handling  
- **login-static**: Static form login handling

### Login Agent Testing

#### Direct Function Test
```bash
# Basic test
node test-local.js

# Custom URL and credentials
node test-local.js --url https://example.com/login --username user@example.com --password pass123

# Debug mode (non-headless)
node test-local.js --headless false --timeout 60000

# Enable recording
node test-local.js --enable_video_recording true --enable_screenshots true
```

#### JSON-RPC Test
```bash
# Start server
npm start

# Test endpoint
node test-rpc.js --port 3001 --url https://example.com/login
```

### Login Agent Configuration Options
- `--url`: Login page URL (default: https://devapp.fmclarity.com/login)
- `--username`: Username (default: test@example.com)
- `--password`: Password (default: test123)
- `--headless`: Run browser in headless mode (default: true)
- `--timeout`: Timeout in milliseconds (default: 30000)
- `--enable_video_recording`: Record video (default: false)
- `--enable_screenshots`: Take screenshots (default: true)
- `--port`: Server port for RPC tests (varies by agent)

## Crawler Agents

### Available Crawler Agents
- **crawler-simplified**: AI-driven crawling with intelligent analysis
- **crawler-text**: Text-focused content crawling
- **crawler-media**: Media-rich content crawling
- **crawler-static**: Static content crawling

### Crawler Agent Testing

#### Direct Function Test
```bash
# Basic test
node test-local.js

# Custom URL and crawl settings
node test-local.js --url https://example.com --maxPages 50 --maxDepth 3

# Debug mode
node test-local.js --headless false --timeout 60000
```

#### JSON-RPC Test
```bash
# Start server
npm start

# Test endpoint
node test-rpc.js --port 3101 --url https://example.com --maxPages 20
```

### Crawler Agent Configuration Options
- `--url`: Starting URL for crawling (default: https://devapp.fmclarity.com)
- `--maxPages`: Maximum pages to crawl (default: 10)
- `--maxDepth`: Maximum crawl depth (default: 2)
- `--headless`: Run browser in headless mode (default: true)
- `--timeout`: Timeout in milliseconds (default: 30000)
- `--port`: Server port for RPC tests (varies by agent)

## Development Workflow

### 1. Make Changes
Edit the relevant files in your chosen repository:
- `src/server.js` - Main server logic
- `package.json` - Dependencies
- `Dockerfile` - Container configuration

### 2. Test Locally
```bash
# Test your changes directly
node test-local.js --headless false

# Test with different parameters
node test-local.js --url https://your-test-site.com
```

### 3. Test JSON-RPC Integration
```bash
# Start server
npm start

# Test RPC endpoint
node test-rpc.js --port [AGENT_PORT]
```

### 4. Deploy to Container
```bash
# From project root
./back/start-container.sh [AGENT_NAME]
```

## Agent Ports

| Agent | Port | Container Name |
|-------|------|----------------|
| login-simplified | 3001 | login-simplified |
| login-text | 3002 | login-text |
| login-media | 3003 | login-media |
| login-static | 3004 | login-static |
| crawler-simplified | 3101 | crawler-simplified |
| crawler-text | 3102 | crawler-text |
| crawler-media | 3103 | crawler-media |
| crawler-static | 3104 | crawler-static |

## Debugging Tips

### Visual Debugging
- Use `--headless false` to see browser actions
- Use `--enable_screenshots true` to capture page states
- Use `--enable_video_recording true` to record full sessions

### Performance Debugging
- Use `--timeout 60000` for longer operations
- Use `--maxPages 1` for quick single-page tests
- Use `--maxDepth 1` to limit crawling depth

### Log Analysis
- All operations are logged with `[AGENT_NAME]` prefix
- Check console output for detailed operation logs
- Use `DEBUG=*` environment variable for verbose logging

## Common Issues

### Environment Issues
1. **OpenAI API errors**: Ensure `OPENAI_API_KEY` is set correctly
2. **MongoDB connection errors**: Check `MONGODB_URI` and ensure MongoDB is running
3. **Browser launch failures**: Check if Chromium is installed

### Testing Issues
1. **Timeout errors**: Increase timeout with `--timeout 60000`
2. **Login failures**: Try different URLs or check site accessibility
3. **RPC connection errors**: Ensure server is running on correct port

### Development Issues
1. **Import errors**: Ensure all dependencies are installed with `npm install`
2. **Permission errors**: Check file permissions and Docker access
3. **Port conflicts**: Use different ports if default ports are occupied

## API Contract Compliance

All agents follow standardized API contracts defined in `shared/api-contracts/`:
- `login-contracts.json` - Login agent specifications
- `crawler-contracts.json` - Crawler agent specifications
- `common-types.json` - Shared types and schemas

### Validation
```bash
# Validate contracts
node shared/api-contracts/validate-contracts.js

# Use validation schemas in code
import { validateLoginRequest, validateLoginResponse } from '../shared/api-contracts/validation-schemas.js';
```

## Integration Testing

### Backend Integration
```bash
# Start agent server
npm start

# Test from backend (if backend is running)
curl -X POST http://localhost:4000/configurations/:id/force-login \
  -H "Content-Type: application/json" \
  -d '{"project_id": "test-project"}'
```

### Multi-Agent Testing
```bash
# Test login agent
cd login-simplified
node test-local.js

# Test crawler agent with login
cd ../crawler-simplified
node test-local.js --url https://protected-site.com
```

## Best Practices

### Development
1. **Test locally first**: Always test changes locally before deploying
2. **Use debug mode**: Use `--headless false` for visual debugging
3. **Check logs**: Monitor console output for errors and warnings
4. **Validate contracts**: Ensure API contract compliance

### Testing
1. **Start simple**: Begin with basic tests and add complexity
2. **Test edge cases**: Test with various URLs and configurations
3. **Monitor performance**: Watch for timeout and memory issues
4. **Document issues**: Keep track of common problems and solutions

### Deployment
1. **Test in container**: Verify container deployment works
2. **Check integration**: Ensure backend integration functions
3. **Monitor logs**: Watch container logs for runtime issues
4. **Update documentation**: Keep README and .cursorrules updated

## Repository-Specific Guides

Each repository includes a detailed `README-LOCAL.md` with:
- Repository-specific setup instructions
- Detailed usage examples
- Troubleshooting guides
- API contract information
- Integration examples

## Support

For issues specific to local development:
1. Check the repository's `README-LOCAL.md`
2. Review the `.cursorrules` file for context
3. Check the `shared/api-contracts/` for API specifications
4. Test with different configurations and parameters
5. Use debug mode and logging for detailed analysis
