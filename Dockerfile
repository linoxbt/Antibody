# The hosted sandbox (antibody cloud serve): any Sui wallet gets its own
# simulated Antibody. Self-hosted installs don't need this file.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
# The recorded walkthrough (site/demo.json) so "Enter the demo" works when this server is opened directly.
RUN node --import tsx scripts/build-site.ts
ENV PORT=8080 ANTIBODY_CLOUD_DATA=/data
EXPOSE 8080
CMD ["node", "bin/antibody.mjs", "cloud", "serve"]
