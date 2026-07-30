FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y python3 build-essential && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# The receive side of delta sync (docs/LITERS_RECEIVE.md). Its own stage so nothing about the Node
# image changes: the runtime below copies ONE binary out of here and the Rust toolchain never ships.
# Docker only re-runs this when liters-sink/ changes, so Node-only iterations do not pay for it.
#
# cargo fetches the liters source from GitHub at the rev pinned in liters-sink/Cargo.toml — no
# submodule, no vendored tree, and the pin is the thing that makes the build reproducible.
FROM rust:1-slim-bookworm AS liters
WORKDIR /build
# rusqlite's `bundled` feature compiles SQLite's amalgamation (needs a C toolchain); git is how cargo
# fetches the pinned rev.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY liters-sink/Cargo.toml ./Cargo.toml
COPY liters-sink/Cargo.lock* ./
COPY liters-sink/src ./src
RUN cargo build --release && strip target/release/noop-liters-sink

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN apt-get update && apt-get install -y python3 build-essential && npm install --omit=dev && apt-get purge -y python3 build-essential && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=liters /build/target/release/noop-liters-sink /app/bin/noop-liters-sink
ENV DATA_DIR=/data
# Matches src/config.ts's default. The sink only runs when LITERS_SINK_ENABLED=1, so shipping the
# binary is inert until VK turns the path on — the deploy that introduces delta sync is deliberately
# not the deploy that switches to it.
ENV LITERS_SINK_BIN=/app/bin/noop-liters-sink
EXPOSE 8080
CMD ["node", "dist/server.js"]
