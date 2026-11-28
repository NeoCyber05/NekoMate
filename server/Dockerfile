FROM node:22-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY --from=frontend /app/public/ui ./public/ui
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.ts"]
