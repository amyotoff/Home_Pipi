# ---- Build stage ----
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc && cp -r src/core/prompts dist/core/prompts

# ---- Runtime stage ----
FROM node:20-slim

# System deps for network tools (used by net-debug and network skills)
RUN apt-get update && apt-get install -y --no-install-recommends \
    iputils-ping \
    net-tools \
    nmap \
    tcpdump \
    traceroute \
    dnsutils \
    iproute2 \
    procps \
    bluez \
    rfkill \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

# Run as non-root
USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
