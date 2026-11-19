# Antibody Guard service (indexer + AI scorer endpoint). Build context: the repository root.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY networks.ts ./
COPY abi ./abi
COPY deployments ./deployments
COPY scripts/lib.ts ./scripts/lib.ts
COPY agent ./agent
COPY service ./service
# the hosted MCP endpoint shares its tools with the stdio server, and calls the API through the SDK's client
COPY mcp/src/tools.ts ./mcp/src/tools.ts
COPY sdk/src/api.ts sdk/src/constants.ts ./sdk/src/
USER node
EXPOSE 8787
CMD ["npx", "tsx", "service/server.ts"]
