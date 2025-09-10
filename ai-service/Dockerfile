FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

    # Install dependencies
    RUN npm install --omit=dev

# Copy source code
COPY src/ ./src/

# Expose port
EXPOSE 5000

# Start the service
CMD ["npm", "start"]
