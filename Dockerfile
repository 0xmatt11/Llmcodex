FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    CHROME_BIN=/usr/bin/chromium-browser \
    HOME=/app
WORKDIR /app
RUN apk add --no-cache \
    ca-certificates \
    chromium \
    chromium-chromedriver \
    freetype \
    harfbuzz \
    nss \
    ttf-freefont \
  && addgroup -S app \
  && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
RUN mkdir -p /app/data /app/browser-data \
  && chown -R app:app /app
USER app
EXPOSE 3000
CMD ["node", "src/index.js"]
