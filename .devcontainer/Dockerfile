# The Dev Container's base image, by digest (check-hygiene rule 14): a tag can be repointed at another
# image with no diff here. Dependabot's docker entry for /.devcontainer proposes each new digest.
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae

# ultra:begin architecture
# likec4's build lays out views with Graphviz's dot and unflatten; GitHub's runner images ship them,
# this base image does not, so the architecture build would fail inside the container without this layer.
RUN apt-get update && apt-get install -y --no-install-recommends graphviz && rm -rf /var/lib/apt/lists/*
# ultra:end architecture
