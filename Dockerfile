FROM node:20-slim

# Install Chromium and dependencies (supports ARM64/AMD64)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto-color-emoji \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Use system Chromium instead of bundled Puppeteer one
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Apply upstream fix for wwebjs issue #201845 (PR #201850): WhatsApp Web
# renamed `_serialized` -> `$1` on message keys and migrated chats to LID,
# causing getChats()/getChatById() to throw "r: r". Re-run is safe (fails if already applied).
RUN node patches/apply-wwebjs-fix.js /app/node_modules/whatsapp-web.js/src/util/Injected/Utils.js

# Generate build version: 0.1.HHMM (time of docker build)
RUN echo "0.1.$(date +%H%M)" > /app/.build-version

# Entrypoint: clean stale Chromium locks then start app
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

CMD ["/entrypoint.sh"]
