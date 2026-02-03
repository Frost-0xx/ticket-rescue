FROM node:20-bookworm-slim

WORKDIR /app
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY backend/package.json ./package.json
RUN npm install --omit=dev

COPY backend/prisma ./prisma
RUN npx prisma generate

COPY backend/src ./src

ENV PORT=3001
EXPOSE 3001

CMD ["node", "src/server.js"]