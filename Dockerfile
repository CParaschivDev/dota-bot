FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

RUN mkdir -p /app/src/data /app/backups /app/logs && chown -R node:node /app

USER node

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

CMD ["node", "index.js"]
