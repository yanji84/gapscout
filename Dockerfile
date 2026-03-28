FROM node:18-slim

# Install Chromium for puppeteer-core browser sources
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Install main project deps
COPY package*.json ./
RUN npm ci --production

# Install server deps
COPY server/package*.json ./server/
RUN cd server && npm ci --production

# Copy source
COPY . .

# Data volume for SQLite + scan outputs
VOLUME /app/data
ENV DATA_DIR=/app/data
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server/index.mjs"]
