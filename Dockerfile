FROM node:20-bookworm-slim

# Install system dependencies for Playwright and video recording
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    curl \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies with retry logic
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm install || (sleep 5 && npm install) || (sleep 10 && npm install)

# Install Playwright browsers and system dependencies (including ffmpeg for video recording)
# This is required for video recording even when using remote browsers
RUN npx playwright install --with-deps chromium

# Copy source code
COPY src/ ./src/

# Copy shared utilities used by crawler/login operations
COPY shared/ ./shared/

# Create directories for temporary files
RUN mkdir -p /tmp/aionqa_videos /tmp/aionqa_screenshots

# No port exposure - runner mode (connects to backend, doesn't expose HTTP server)

# Start the runner (polls backend for jobs)
CMD ["node", "src/runner.js"]
