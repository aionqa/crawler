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
# Works when build context is the unified-crawler/ directory (AWS) or project root (docker-compose)
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Install Playwright browsers and system dependencies (including ffmpeg for video recording)
# This is required for video recording even when using remote browsers
RUN npx playwright install --with-deps chromium

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
