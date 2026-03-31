FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/src/data

ENV NODE_ENV=production

CMD ["sh", "-c", "node index.js & node web.js"]
