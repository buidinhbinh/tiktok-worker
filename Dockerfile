FROM node:22-bookworm-slim

# Cài đặt Chromium và các font/thư viện đồ họa cần thiết cho Linux
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PORT=5050

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY tiktok_qr_worker.js ./

EXPOSE 5050

CMD ["node", "tiktok_qr_worker.js"]
