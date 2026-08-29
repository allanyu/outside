# The relay is one long-lived process holding WebSockets open for hours, with
# SQLite and uploaded files on disk. It wants a container with a volume, not a
# serverless function.
FROM node:22-slim

# better-sqlite3 ships prebuilds; keep the toolchain around in case it has to
# build from source on this platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# DATA_DIR is a mounted volume: the SQLite file and uploads both live here.
# PORT is injected by most hosts at runtime; DATA_DIR is the mounted volume,
# holding both the SQLite file and uploaded images.
ENV NODE_ENV=production \
    DATA_DIR=/data

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
