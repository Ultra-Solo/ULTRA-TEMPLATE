# The base image is pinned by digest as well as tag: a tag can be repointed at a different image.
# Dependabot updates both together.
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# npm installs the dependencies, then leaves the image: nothing at runtime calls it, and the copy bundled
# with Node carries its own dependencies, with vulnerabilities of their own.
RUN npm ci --omit=dev --ignore-scripts \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
# Node runs TypeScript directly by stripping types, so the sources ship as they are.
COPY src ./src
# The release this image is: mcp-publish.yml passes the tag's version. A build without one reports the
# development version (src/config.ts), so it cannot be taken for a release.
ARG VERSION
ENV MCP_SERVER_VERSION=$VERSION
USER node
# The MCP Registry verifies that whoever publishes server.json owns this image by reading this label;
# it must equal "name" in server.json exactly. The source label links the image to the repository.
LABEL io.modelcontextprotocol.server.name="io.github.ultra-solo/ultra-template"
LABEL org.opencontainers.image.source="https://github.com/Ultra-Solo/ULTRA-TEMPLATE"
# The default transport is stdio: the protocol is stdin and stdout, so run this image with -i.
# With MCP_TRANSPORT=http it listens on every interface with no authentication, like the task
# services: front it with a proxy that adds both. EXPOSE names the port that form listens on.
EXPOSE 3000
CMD ["node", "src/main.ts"]
