FROM mcr.microsoft.com/playwright:v1.55.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3200
CMD ["node", "src/index.js"]
