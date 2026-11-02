# The hosted sandbox (antibody cloud serve): any Sui wallet gets its own
# simulated Antibody. Self-hosted installs don't need this file.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
# The recorded walkthrough (site/demo.json) so "Enter the demo" works when this server is opened directly.
RUN node --import tsx scripts/build-site.ts && chown -R root:root /app && chmod -R a+rX,go-w /app
ENV PORT=8080 ANTIBODY_CLOUD_DATA=/data HOME=/home/node
EXPOSE 8080
# The server runs as the unprivileged node user. Platform volumes (Railway's
# /data) are mounted root-owned, so the entrypoint hands /data to node and then
# drops root for good before anything listens on the network.
CMD ["sh", "-c", "mkdir -p \"$ANTIBODY_CLOUD_DATA\" && chown -R node:node \"$ANTIBODY_CLOUD_DATA\" && exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --bounding-set=-all node bin/antibody.mjs cloud serve"]
