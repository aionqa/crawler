# CLI Examples

This directory contains example JSON payload files for testing the unified crawler CLI tool.

## Usage

### List available examples
```bash
node src/cli.js --list-examples
```

### Run with a JSON payload file
```bash
node src/cli.js --file cli-examples/login-example.json
```

### Run with environment variables
```bash
export OPENAI_API_KEY="your-openai-api-key"
export TEST_USERNAME="your-username"
export TEST_PASSWORD="your-password"
node src/cli.js --file cli-examples/login-example.json
```

## Example Files

### login-example.json
Tests login functionality with AI-driven approach.

### crawl-example.json
Tests website crawling with content extraction.

### analysis-example.json
Tests page analysis and structure detection.

## Output Format

The CLI outputs structured JSON logs to stdout, making it easy to parse and process the results programmatically.

Example output:
```json
{"timestamp":"2024-01-01T12:00:00.000Z","level":"INFO","message":"Starting operation","operation":"login","url":"https://example.com/login"}
{"timestamp":"2024-01-01T12:00:01.000Z","level":"INFO","message":"Login credentials","username":"test@example.com","passwordLength":11}
{"timestamp":"2024-01-01T12:00:05.000Z","level":"INFO","message":"Operation completed","success":true,"duration_ms":5000}
```

## Local Browser Usage

The CLI tool uses the system's local Chromium browser installation instead of installing browsers in containers. This makes it perfect for local testing and development.

## Environment Variables

- `OPENAI_API_KEY` - Required for AI-powered operations
- `TEST_USERNAME` - Default username for login testing
- `TEST_PASSWORD` - Default password for login testing
- `CLI_MODE` - Automatically set to 'true' by the CLI tool
