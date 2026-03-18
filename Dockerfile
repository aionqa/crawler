FROM node:20-bookworm-slim

# Install system dependencies for Playwright, video recording, and OWASP ZAP
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    curl \
    ffmpeg \
    default-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# Install OWASP ZAP for security scans (baseline / passive scanning)
ENV ZAP_VERSION=2.16.1
ENV ZAP_HOME=/opt/zap
RUN wget -q "https://github.com/zaproxy/zaproxy/releases/download/v${ZAP_VERSION}/ZAP_${ZAP_VERSION}_Linux.tar.gz" -O /tmp/zap.tar.gz \
    && mkdir -p /opt \
    && tar -xzf /tmp/zap.tar.gz -C /opt \
    && mv "/opt/ZAP_${ZAP_VERSION}" "${ZAP_HOME}" \
    && rm /tmp/zap.tar.gz \
    && ln -sf "${ZAP_HOME}/zap.sh" /usr/local/bin/zap.sh

# Install k6 binary for load-test jobs executed by the helper.
ENV K6_VERSION=0.50.0
RUN wget -q "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-amd64.tar.gz" -O /tmp/k6.tar.gz \
    && tar -xzf /tmp/k6.tar.gz -C /tmp \
    && mv "/tmp/k6-v${K6_VERSION}-linux-amd64/k6" /usr/local/bin/k6 \
    && chmod +x /usr/local/bin/k6 \
    && rm -rf /tmp/k6.tar.gz "/tmp/k6-v${K6_VERSION}-linux-amd64"

# Avoid installing browsers into /root/.cache (can be flaky on some Docker backends).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Set working directory
WORKDIR /app

# Copy package files
# Works when build context is the unified-crawler/ directory (AWS) or project root (docker-compose)
COPY package*.json ./

# Install Node.js dependencies
# Self-hosted runners can have occasional registry network resets; increase retries/timeouts.
RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm ci --no-audit --no-fund

# Install Playwright browsers and system dependencies (including ffmpeg for video recording)
# This is required for video recording even when using remote browsers
RUN mkdir -p /ms-playwright && npx playwright install --with-deps chromium

# Copy source code
# Works when build context is the unified-crawler/ directory (AWS) or project root (docker-compose)
COPY src/ ./src/

# Copy shared utilities used by crawler/login operations
# Works when build context is the unified-crawler/ directory (AWS) or project root (docker-compose)
COPY shared/ ./shared/

# Create directories for temporary files
RUN mkdir -p /tmp/aionqa_videos /tmp/aionqa_screenshots

# No port exposure - runner mode (connects to backend, doesn't expose HTTP server)

# Start the runner (polls backend for jobs)
CMD ["node", "src/runner.js"]
