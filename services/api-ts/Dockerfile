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
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
