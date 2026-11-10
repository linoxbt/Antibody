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
# One OS user per role, for ANTIBODY_MODE=mainnet (unused by the sandbox).
RUN groupadd --system antibody \
 && for r in control user agent ingest signer; do useradd --system --gid antibody --home-dir /srv/antibody --shell /usr/sbin/nologin "antibody-$r"; done
ENV PORT=8080 ANTIBODY_CLOUD_DATA=/data HOME=/home/node
EXPOSE 8080
# The server runs as the unprivileged node user. Platform volumes (Railway's
# /data) are mounted root-owned, so the entrypoint hands /data to node and then
# drops root for good before anything listens on the network.
#
# ANTIBODY_MODE=mainnet runs instead an always-on Antibody for one real account:
# control, signer, agent and the sentinel, each as its own OS user with an encrypted
# key (scripts/railway-mainnet.sh; state on a volume at /srv/antibody).
CMD ["sh", "-c", "if [ \"$ANTIBODY_MODE\" = mainnet ]; then exec bash /app/scripts/railway-mainnet.sh; fi; mkdir -p \"$ANTIBODY_CLOUD_DATA\" && chown -R node:node \"$ANTIBODY_CLOUD_DATA\" && exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --bounding-set=-all node bin/antibody.mjs cloud serve"]
