FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
RUN mkdir -p /app/data && chown -R app:app /app
USER app
EXPOSE 3000
CMD ["node", "src/index.js"]
