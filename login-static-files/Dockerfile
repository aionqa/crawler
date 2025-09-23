FROM mcr.microsoft.com/playwright:v1.55.0-jammy
WORKDIR /app
COPY login-static/package*.json ./
RUN npm install --omit=dev
COPY login-static/ .
ENV NODE_ENV=production
EXPOSE 3004
CMD ["node", "src/index.js"]
