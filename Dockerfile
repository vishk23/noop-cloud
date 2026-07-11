FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y python3 build-essential && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN apt-get update && apt-get install -y python3 build-essential && npm install --omit=dev && apt-get purge -y python3 build-essential && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["node", "dist/server.js"]
