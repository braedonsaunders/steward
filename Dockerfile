FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package*.json ./
COPY scripts ./scripts
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates nmap tshark snmp \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /ms-playwright \
  && npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 --ingroup nodejs nextjs
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates wget gpg libcap2-bin nmap tshark snmp \
  && wget -q https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb \
  && dpkg -i packages-microsoft-prod.deb \
  && rm packages-microsoft-prod.deb \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends powershell \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=deps /app/node_modules/playwright ./node_modules/playwright
COPY --from=deps /app/node_modules/playwright-core ./node_modules/playwright-core
COPY --from=deps /ms-playwright /ms-playwright

RUN DEBIAN_FRONTEND=noninteractive node node_modules/playwright/cli.js install-deps chromium \
  && if [ -x /usr/bin/dumpcap ]; then chgrp nodejs /usr/bin/dumpcap && chmod 750 /usr/bin/dumpcap && setcap cap_net_admin,cap_net_raw=eip /usr/bin/dumpcap; fi \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/.steward && chown -R nextjs:nodejs /app/.steward /ms-playwright

USER nextjs
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
