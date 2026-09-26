# Contributing

## The loop

1. For a large or structural change, open an issue first and agree on the approach there. A pull request is a poor place to discover that the design was not wanted.
2. Branch from `main`.
3. Make the change, with a test for any behaviour it adds or fixes.
4. Run `node scripts/verify.mjs`. It runs each module's checks as CI does, so red here means red there, and lints the workflows with the pinned tools (`node scripts/tools.mjs install --local`); the image builds, the online workflow audit and the security scans run on the pull request.
5. Open a pull request whose **title** follows [Conventional Commits](https://www.conventionalcommits.org/): `feat: add task search`, `fix(tasks): reject empty titles`. Pull requests are squash-merged, so the title becomes the commit message on `main`.
<!-- ultra:begin release -->
6. The title's type sets the next version: `fix` makes a patch release, `feat` a minor release, and `!` or a `BREAKING CHANGE:` footer a major release.
<!-- ultra:end release -->

Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

## What the build enforces

- **`verify` must pass.** It is the only required check; see [ADR-0002](docs/adr/0002-one-required-check.md).
- **Third-party actions are pinned to a commit SHA**, and every workflow declares its permissions and job timeouts. zizmor audits every workflow for security mistakes, and no npm install may run a dependency's install scripts (`--ignore-scripts`).
- **Nothing that does not belong gets tracked:** no `.env` files, no dependency directories, no invalid JSON, no file over 4 MB, no invisible characters and no paths into a home directory.
- **Architecture boundaries hold.** Each service checks its own import rules; see [ADR-0005](docs/adr/0005-layered-services-with-enforced-boundaries.md).

## Architecture decisions

A change to structure, a dependency direction, or a tool that other code relies on gets an ADR in [`docs/adr/`](docs/adr/). Copy [`0000-template.md`](docs/adr/0000-template.md). ADRs are amended, not rewritten: a later ADR supersedes an earlier one, and the earlier one's status points to it.

## Reporting problems

Use the issue forms. Security problems go through the private process in [SECURITY.md](SECURITY.md), never a public issue.
