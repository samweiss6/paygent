# Paygent container. Test mode only.
# Base image pinned by version; pin by digest in your own deployments (docker pull node:24.11-alpine && docker inspect).
FROM node:24.11-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency install scripts run.
RUN npm ci --omit=dev --ignore-scripts

FROM node:24.11-alpine
ENV NODE_ENV=production PAYGENT_HOME=/data PAYGENT_CONTAINER=1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY src ./src
RUN mkdir -p /data && chown node:node /data && chmod 700 /data && ln -s /app/bin/paygent.js /usr/local/bin/paygent
USER node
VOLUME ["/data"]
EXPOSE 7402
ENTRYPOINT ["node", "/app/bin/paygent.js"]
CMD ["start"]
