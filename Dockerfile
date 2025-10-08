FROM node:18-slim

# Install system dependencies for Playwright (including ffmpeg for video recording)
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY unified-crawler/package*.json ./

# Install Node.js dependencies
RUN npm install

# Install Playwright browsers and system dependencies (including ffmpeg for video recording)
# This is required for video recording even when using remote browsers
RUN npx playwright install --with-deps chromium

# Copy source code
COPY unified-crawler/src/ ./src/

# Copy shared utilities
COPY shared/ ./shared/

# Create directories for temporary files
RUN mkdir -p /tmp/aionqa_videos /tmp/aionqa_screenshots

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["npm", "start"]
