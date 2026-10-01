# Security policy

## Reporting a vulnerability

Report it privately: **[Report a vulnerability](https://github.com/Ultra-Solo/ULTRA-TEMPLATE/security/advisories/new)** (Security tab → *Report a vulnerability*). If the link says reporting is off, a maintainer enables it with `node scripts/configure-github.mjs` or under Settings → Code security → Private vulnerability reporting.

Please do not open a public issue or pull request for it. Include the affected file, endpoint or command, how to reproduce it, and what an attacker gains. No response time is promised until this file states one.

### What happens after you report

1. A maintainer acknowledges the report, confirms whether it is a vulnerability, and works out which versions it affects.
2. The fix is prepared privately in the advisory's temporary fork, released, and the advisory is published, crediting you unless you ask not to be named.
3. Until then, please keep the details confidential, and test only against systems you own.

## Supported versions

Fixes land on `main`. Only the latest release receives them.

## If a secret leaks

A secret that reached a commit is compromised even after the commit is removed: rewriting history does not revoke it, and any clone or fork may already hold a copy. **Revoke it first, then clean up.**

List every secret the project uses, what it grants, and how to rotate it:

| Secret | What it grants | How to rotate |
|---|---|---|
| *none yet* | | |

## What guards against leaks

- **The `secrets` job in `.github/workflows/verify.yml`** runs gitleaks over the commits each pull request, merge queue entry or push adds, and fails the required check on a finding. It works on every plan, private repositories included.
- **GitHub secret scanning and push protection** block a push before it lands, where the repository's plan allows them. `scripts/configure-github.mjs` enables both.
- **`.github/workflows/security.yml`** scans the whole history with gitleaks each week. It is report-only, and fails only when the scan could not run.

A finding that is not a secret (a test fixture shaped like a token, say) is silenced in `.gitleaksignore`, one fingerprint per line, as the job's gitleaks output prints it for each finding (redacting hides the secret, not the fingerprint), with a `#` comment above saying why. Never silence a real secret there: revoke it, as above.
- **`.gitignore`** keeps `.env` and `.env.*` out, and **`scripts/check-hygiene.mjs`** fails the build if one is tracked anyway.
- **Dependabot** proposes dependency and SHA-pinned action updates every week.
