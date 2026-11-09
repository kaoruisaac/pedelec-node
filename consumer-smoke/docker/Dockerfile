# Clean, non-root Debian/Ubuntu consumer for the packed tarball. BASE: node:24-bookworm-slim or ubuntu:24.04.
ARG BASE=node:24-bookworm-slim
FROM node:24-bookworm-slim AS node
FROM ${BASE}
# Ubuntu has no Node: take the official binary from the Debian image (only the runtime, nothing from this repo).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && apt-get update && apt-get install -y --no-install-recommends procps ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 10001 consumer
USER consumer
WORKDIR "/home/consumer/app with space"
COPY --chown=consumer package.tgz /home/consumer/package.tgz
COPY --chown=consumer smoke.mjs fake-codex.mjs ./
RUN npm init -y >/dev/null && npm pkg set type=module && npm install --no-audit --no-fund /home/consumer/package.tgz
CMD ["node", "smoke.mjs", "--report", "/home/consumer/report.json"]
