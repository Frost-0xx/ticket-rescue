FROM node:20-alpine

WORKDIR /app

COPY backend/package.json ./package.json
RUN npm install --omit=dev

COPY backend/prisma ./prisma
RUN npx prisma generate

COPY backend/src ./src

ENV PORT=3001
EXPOSE 3001

CMD ["node", "src/server.js"]