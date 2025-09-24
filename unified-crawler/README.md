# Unified Crawler

A comprehensive AI-powered web crawling and login automation system that unifies all crawling and login functionalities into a single, flexible module.

## Features

- **Multiple Operation Modes**: Supports 6 different modes for various use cases
- **AI-Powered**: Uses OpenAI GPT-4o-mini for intelligent analysis and decision making
- **Comprehensive Logging**: Full logging and AI conversation tracking
- **Flexible Architecture**: Single module that replaces multiple specialized modules
- **JSON-RPC API**: Standardized communication protocol
- **CLI Support**: Command-line interface for testing and development

## Supported Modes

### 1. Auto Mode (Default)
- **Description**: AI-driven approach with automatic mode selection
- **Use Case**: General purpose, works well for most scenarios
- **Features**: Intelligent form detection, multi-approach login attempts

### 2. Media Mode
- **Description**: Screenshot analysis with AI vision capabilities
- **Use Case**: Complex visual interfaces, CAPTCHA handling
- **Features**: Screenshot capture, visual element analysis

### 3. Text Mode
- **Description**: HTML text analysis with AI language processing
- **Use Case**: Text-heavy pages, content extraction
- **Features**: HTML parsing, text content analysis

### 4. Forms Mode
- **Description**: Form field analysis using Playwright selectors
- **Use Case**: Form-heavy applications, structured data entry
- **Features**: Form detection, field mapping, validation

### 5. Static Mode
- **Description**: Standard field ID matching for common patterns
- **Use Case**: Simple forms, standard login pages
- **Features**: Predefined selectors, fast execution

### 6. Script Mode
- **Description**: Custom script execution for advanced scenarios
- **Use Case**: Complex workflows, custom automation
- **Features**: JavaScript execution, custom logic

## API Endpoints

### JSON-RPC Methods

#### `attemptLogin`
Attempts to login to a website using specified credentials and mode.

**Parameters:**
- `url` (string): Login page URL
- `username` (string): Username
- `password` (string): Password
- `cookies` (array): Initial cookies
- `context` (object): Operation context including mode

#### `startCrawl`
Starts crawling a website using specified mode.

**Parameters:**
- `url` (string): Starting URL
- `cookies` (array): Initial cookies
- `context` (object): Operation context including mode

#### `queueLoginJob`
Queues a login job for background execution.

**Parameters:**
- `url` (string): Login page URL
- `context` (object): Operation context including credentials and mode

#### `getJobStatus`
Gets the status of a queued job.

**Parameters:**
- `job_id` (string): Job identifier

## Usage Examples

### CLI Usage

```bash
# Login with auto mode
node src/cli.js login https://example.com/login auto

# Crawl with media mode
node src/cli.js crawl https://example.com media

# Login with static mode
node src/cli.js login https://example.com/login static

# Crawl with text mode
node src/cli.js crawl https://example.com text
```

### API Usage

```javascript
// Login request
const loginRequest = {
  jsonrpc: "2.0",
  method: "attemptLogin",
  params: {
    url: "https://example.com/login",
    username: "user@example.com",
    password: "password123",
    cookies: [],
    context: {
      project_id: "test-project",
      mode: "auto",
      options: {
        headless: true,
        timeout: 30000,
        enable_screenshots: true
      }
    }
  },
  id: 1
};

// Crawl request
const crawlRequest = {
  jsonrpc: "2.0",
  method: "startCrawl",
  params: {
    url: "https://example.com",
    cookies: [],
    context: {
      project_id: "test-project",
      mode: "media",
      options: {
        max_depth: 3,
        max_pages: 50
      }
    }
  },
  id: 2
};
```

## Environment Variables

- `OPENAI_API_KEY`: Required for AI-powered modes
- `BACKEND_URL`: Backend service URL (default: http://back:4000)
- `PORT`: Server port (default: 3000)
- `TEST_USERNAME`: Default username for CLI testing
- `TEST_PASSWORD`: Default password for CLI testing

## Installation

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Set environment variables
export OPENAI_API_KEY="your-api-key-here"

# Start the server
npm start

# Or run in development mode
npm run dev
```

## Docker Support

```bash
# Build the Docker image
docker build -t unified-crawler .

# Run the container
docker run -p 3000:3000 -e OPENAI_API_KEY=your-key unified-crawler
```

## Architecture

The unified crawler consolidates functionality from multiple specialized modules:

- **login-simplified**: Auto mode functionality
- **login-media**: Media mode functionality  
- **login-text**: Text mode functionality
- **login-static**: Static mode functionality
- **crawler-simplified**: Auto crawl functionality
- **crawler-media**: Media crawl functionality
- **crawler-text**: Text crawl functionality
- **crawler-static**: Static crawl functionality
- **manual-analysis**: Script mode functionality

## Response Format

All operations return standardized responses:

```javascript
{
  "jsonrpc": "2.0",
  "result": {
    "success": true,
    "message": "Operation completed successfully",
    "duration_ms": 1500,
    "final_url": "https://example.com/dashboard",
    "final_title": "Dashboard",
    "details": {
      // Operation-specific details
    },
    "screenshots": [],
    "video": null
  },
  "id": 1
}
```

## Error Handling

The system provides comprehensive error handling with detailed error messages and stack traces:

```javascript
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32603,
    "message": "Operation failed",
    "data": {
      "error": "Detailed error information",
      "timestamp": "2024-01-01T00:00:00.000Z"
    }
  },
  "id": 1
}
```

## Logging

The unified crawler provides comprehensive logging:

- **Console Logging**: Real-time operation logs
- **GELF Logging**: Structured logging to Graylog
- **Backend Logging**: Job-specific logs sent to backend
- **AI Conversation Logging**: Complete AI interaction history

## Testing

```bash
# Test with CLI
node src/cli.js login https://httpbin.org/forms/post auto

# Test with curl
curl -X POST http://localhost:3000/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "attemptLogin",
    "params": {
      "url": "https://httpbin.org/forms/post",
      "username": "test",
      "password": "test",
      "context": {
        "project_id": "test",
        "mode": "auto"
      }
    },
    "id": 1
  }'
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT License - see LICENSE file for details.
