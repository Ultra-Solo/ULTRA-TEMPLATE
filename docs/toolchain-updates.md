# Toolchain updates

Every piece of third-party code this repository runs is pinned ([ADR-0003](adr/0003-pin-third-party-code.md)), and a pin that nothing updates is one that quietly goes stale. This page lists every pin by what keeps it current. There are three kinds.

## Updated by Dependabot

Weekly, grouped, as pull requests that must pass `verify` like any other.

- **GitHub Actions** — every `uses:` is a commit SHA with its version as a comment; Dependabot moves both together, in the workflows and in each local action under `.github/actions/`, which its github-actions entry lists (`check-hygiene` rule 19 fails a directory it misses, and an action left at two SHAs). Every entry waits seven days after a release before proposing it.
- **Container base images** — each `FROM` carries a digest as well as a tag, and Dependabot updates the digest within the tag. It does not move the language version in the tag; that is the next section's job.
- **Each module's dependencies** — every npm lockfile, `go.mod`, and `uv.lock`, one group per module. Biome is among them, pinned exactly because its formatter's output can change between releases: an update that changes layout carries the reformat in the same pull request ([ADR-0012](adr/0012-lint-and-format-typescript-with-biome.md)).
<!-- ultra:begin devcontainer -->
- **Dev Container features** — the toolchain features in `.devcontainer/devcontainer.json`.
- **The Dev Container's base image** — the digest in `.devcontainer/Dockerfile`'s `FROM`.
<!-- ultra:end devcontainer -->

## Language versions — declared once, moved on purpose

Dependabot holds these back on purpose. Each is declared in one file; every other place that names it is a copy, and `check-hygiene` rule 17 fails the build and names each copy still on the old version. So move a language version by changing its declaration and then every copy the check names, in one pull request, and let `verify` prove it.

- **Node** — `.node-version` (major <!-- generated:version .node-version -->24<!-- /generated -->), read by every `setup-node` step and by `scripts/agent-env.mjs`. Its copies: `engines` in each `package.json`, the `@types/node` major, the `node:` tag in each Node Dockerfile, and the Dev Container feature.
<!-- ultra:begin go-service -->
- **Go** — the `go` line in `services/api-go/go.mod` (<!-- generated:version services/api-go/go.mod -->1.26<!-- /generated -->), read by `setup-go`. Its copies: the `golang:` tag in its Dockerfile and the Dev Container feature.
<!-- ultra:end go-service -->
<!-- ultra:begin py-service -->
- **Python** — `services/api-py/.python-version` (<!-- generated:version services/api-py/.python-version -->3.14<!-- /generated -->), read by uv; `requires-python` in `pyproject.toml` is the oldest version the service supports (<!-- generated:floor services/api-py/pyproject.toml -->3.13<!-- /generated -->), which mypy's `python_version` must equal. Its copies: the `python:` tag in its Dockerfile and the Dev Container feature.
<!-- ultra:end py-service -->

## Pinned by hand — one manifest, moved by one command

Dependabot cannot see a tool a workflow downloads by version, so each is pinned once, in `scripts/tools/tools.json`, with the SHA-256 of its release asset for every platform it is installed on. `scripts/tools.mjs` installs and runs them from there, in CI, in local checks and in an agent's session; `check-hygiene` rule 16 fails a version written into a workflow instead; `verify` fails when the copy on PATH is a different version; and `pins.yml` lists each one beside its latest release every week. The move stays a person's.

<!-- generated:tools-table -->
| Tool | Version | Needed | Checksum |
|---|---|---|---|
| [actionlint](https://github.com/rhysd/actionlint/releases) | 1.7.12 | everywhere | the release's checksum file |
| [shellcheck](https://github.com/koalaman/shellcheck/releases) | 0.11.0 | everywhere | the digest GitHub records for each asset |
| [zizmor](https://github.com/zizmorcore/zizmor/releases) | 1.30.1 | everywhere | the digest GitHub records for each asset |
| [golangci-lint](https://github.com/golangci/golangci-lint/releases) | 2.13.2 | with a Go module | the release's checksum file |
| [uv](https://github.com/astral-sh/uv/releases) | 0.12.18 | with a Python module | the `.sha256` file beside each asset |
| [gitleaks](https://github.com/gitleaks/gitleaks/releases) | 8.30.1 | in CI only | the release's checksum file |
| [trivy](https://github.com/aquasecurity/trivy/releases) | 0.74.0 | in CI only | the release's checksum file |
| [mcp-publisher](https://github.com/modelcontextprotocol/registry/releases) | 1.8.1 | in CI only | the digest GitHub records for each asset |
| [govulncheck](https://github.com/golang/vuln/tags) | 1.8.0 | in CI only | none: run as `go run golang.org/x/vuln/cmd/govulncheck@v1.8.0` |
| [pip-audit](https://pypi.org/project/pip-audit/) | 2.10.1 | in CI only | none: run as `uvx pip-audit==2.10.1` |
| [devcontainer-cli](https://github.com/devcontainers/cli/tags) | 0.89.0 | in CI only | none: run as `devcontainer --version` |
<!-- /generated -->

To move one, read its release notes, then:

```bash
node scripts/tools.mjs bump <tool> [X.Y.Z]   # the latest release when no version is given
```

`bump` takes each new checksum from the release itself — its checksum file, a checksum beside each asset, or the digest GitHub records — and never from anywhere else: the point of pinning one is that a replaced download fails. It needs `GH_TOKEN` for a digest GitHub records. The `checksums` job in `pins.yml` then compares every platform's pin with its release on the pull request; where `bump` cannot run, add the asset with any checksum and copy the one that job prints as published. Run `node scripts/verify.mjs`: rule 17 names any other copy of the version, such as the golangci-lint version the Dev Container's go feature is given, and CI proves the new binary works.
