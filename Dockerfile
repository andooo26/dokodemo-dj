# 公開用サーバのイメージ。MIDI は扱わないので native モジュールは入れない。
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN node scripts/setup-mediapipe.mjs && npx next build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production LOCAL_MODE=0 PORT=3000
COPY --from=build /app ./
EXPOSE 3000
CMD ["node", "server.js"]
