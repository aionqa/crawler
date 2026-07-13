# AionQA Unified Crawler

`unified-crawler` is the runner container that executes AionQA jobs (crawl, login, workflow-driven checks, security checks, and related browser tasks).

It behaves like a GitHub Actions runner:

1. Authenticates with the backend using a runner token
2. Polls for assigned jobs
3. Executes the job with Playwright and AI integrations
4. Uploads artifacts (screenshots/videos/logs) through backend-issued presigned URLs
5. Reports status and results back to backend APIs

## Requirements

- Node.js 20+
- npm
- A valid `RUNNER_TOKEN` generated from AionQA
- Access to backend API (`BACKEND_URL`)

For easiest setup, run in Docker (Playwright/Chromium deps are baked into the image).

## Quick Start (Local)

```bash
npm ci
```

PowerShell example:

```powershell
$env:RUNNER_TOKEN="your-runner-token"
$env:BACKEND_URL="https://api.aionqa.com"
$env:POLL_INTERVAL="3000"
npm start
```

## Quick Start (Docker)

```bash
docker build -t aionqa-unified-crawler .
docker run --rm \
  --name aionqa-unified-crawler \
  -e RUNNER_TOKEN=your-runner-token \
  -e BACKEND_URL=https://api.aionqa.com \
  -e POLL_INTERVAL=3000 \
  -e HEALTH_CHECK_PORT=8080 \
  -p 8080:8080 \
  aionqa-unified-crawler
```

## Configuration

### Required

- `RUNNER_TOKEN`: Runner authentication token (service exits if missing)

### Common Optional

- `BACKEND_URL`: Backend base URL (default: `https://api.aionqa.com`)
- `POLL_INTERVAL`: Poll interval in milliseconds (default: `3000`)
- `RUNNER_ID`: Explicit runner identifier
- `RUNNER_TYPE`: `user-managed` or `service-managed` (default: `user-managed`)
- `HEALTH_CHECK_PORT`: Local health endpoint port (default: `8080`)
- `AI_SERVICE_URL`: Override AI service base URL
- `OPENAI_API_KEY`: Optional fallback key for legacy flows

### Single-Job Mode (Optional)

- `TASK_MODE=single-job`
- `JOB_ID=<job-id>`
- `RUNNER_JOB_FETCH_TIMEOUT_MS`
- `SINGLE_JOB_FETCH_RETRY_DELAYS_MS` (comma-separated milliseconds)

Use this mode for one-off execution in controlled environments.

## Health Check

The runner exposes a minimal health endpoint for orchestration:

- `GET /health` on `HEALTH_CHECK_PORT` (default `8080`)

## NPM Scripts

- `npm start` - start runner
- `npm run dev` - watch mode
- `npm test` - run test suite
- `npm run test:watch` - interactive watch mode
- `npm run test:ui` - Vitest UI
