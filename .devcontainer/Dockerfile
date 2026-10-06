# The Dev Container's base image, by digest (check-hygiene rule 14): a tag can be repointed at another
# image with no diff here. Dependabot's docker entry for /.devcontainer proposes each new digest.
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae

# ultra:begin architecture
# likec4's build lays out views with Graphviz's dot and unflatten; GitHub's runner images ship them,
# this base image does not, so the architecture build would fail inside the container without this layer.
RUN apt-get update && apt-get install -y --no-install-recommends graphviz && rm -rf /var/lib/apt/lists/*
# ultra:end architecture
# ultra:begin web
# The browser smoke test drives Playwright's pinned Chromium; GitHub's runner images ship the OS
# libraries and fonts it needs, this base image does not, so the smoke could not run inside the
# container without this layer. The list is what `playwright install-deps chromium` installs on
# Ubuntu 24.04, minus xvfb, which only a headed run needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
  libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
  libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  fonts-liberation fonts-unifont fonts-noto-color-emoji fonts-ipafont-gothic fonts-wqy-zenhei \
  fonts-tlwg-loma-otf fonts-freefont-ttf xfonts-cyrillic xfonts-scalable libfontconfig1 libfreetype6 \
  && rm -rf /var/lib/apt/lists/*
# ultra:end web
