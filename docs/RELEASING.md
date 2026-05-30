# Releasing USRCP to npm

This documents the npm publish rail. It covers the TypeScript/Node packages
only — the Homebrew core formula, the VS Code extension, and the Python
`usrcp-hermes` package ship through their own channels.

## What gets published

`scripts/release/publish.mjs` owns the package list (`PUBLISH_ORDER`) and the
dependency-ordered publish. Today that is:

| Tier | Packages |
|------|----------|
| 1 | `usrcp-local` |
| 2 | `usrcp-adapter-kit`, `usrcp-stream` |
| 3 | `usrcp-obsidian`, `usrcp-linear`, `usrcp-github`, `usrcp-gmail`, `usrcp-google-calendar`, `usrcp-discord`, `usrcp-telegram`, `usrcp-slack`, `usrcp-imessage`, `usrcp-claude-code`, `usrcp-extension` |

**Excluded by design:** `usrcp-cloud` (hosted server, deployed not installed),
`usrcp-vscode` (VS Code marketplace), `usrcp-hermes` (pip).

## How the file: → versioned dep bridge works

In the repo, adapters depend on core via `file:../usrcp-local` etc. so each
package stays independently installable/buildable (the per-package CI matrix and
the Homebrew formula both rely on this — there is no workspace root). Those
`file:` specs can't be published.

The release script bridges the two **only at release time**:

1. Verifies the git tree is clean.
2. Builds every package in dependency order.
3. Rewrites each `file:../usrcp-<x>` dep to `^<that package's version>`.
4. `npm pack` (dry-run) or `npm publish` (`--execute`) in dependency order.
5. Restores the rewritten `package.json` files via `git checkout` — always,
   even on failure — so the working tree never keeps the rewritten specs.

Because the rewrite is confined to the release script, day-to-day dev, the CI
test matrix, and the brew build are untouched.

## Dry run (safe, no auth, no network)

```bash
node scripts/release/publish.mjs                 # all packages
node scripts/release/publish.mjs --only=usrcp-local,usrcp-linear
```

Builds, rewrites, packs each package to `release-artifacts/*.tgz`, prints the
rewritten internal deps + tarball file list, and restores. Inspect the tarballs
before publishing.

To validate a real consumer install without publishing, install the packed
tarballs together into a clean project (npm satisfies the inter-package
version ranges from the co-installed tarballs):

```bash
mkdir /tmp/usrcp-install-test && cd /tmp/usrcp-install-test && npm init -y
npm install /path/to/usrcp/release-artifacts/usrcp-local-*.tgz \
            /path/to/usrcp/release-artifacts/usrcp-adapter-kit-*.tgz \
            /path/to/usrcp/release-artifacts/usrcp-stream-*.tgz \
            /path/to/usrcp/release-artifacts/usrcp-linear-*.tgz
# postinstall builds better-sqlite3; then `npx usrcp init --dev` etc.
```

## Real publish

Requires an npm automation token with publish rights to the `usrcp-*` names,
exposed as `NODE_AUTH_TOKEN` (CI reads the `NPM_TOKEN` repo secret).

**Via CI (preferred):** push a version tag.

```bash
git tag v0.1.8 && git push origin v0.1.8
```

`.github/workflows/publish.yml` runs the dry-run pack, then publishes with the
token. It can also be run manually from the Actions tab (`execute: true`).

**Locally (fallback):**

```bash
npm whoami                                  # confirm you're authed
node scripts/release/publish.mjs --execute
```

## Versioning

All packages are released in lockstep at the same version (the `^` rewrite
assumes a coordinated release). Bump every publishable `package.json` to the new
version before tagging. (A future improvement: a `version` subcommand in the
release script to bump them together.)

## First publish checklist

- [ ] Add the `NPM_TOKEN` repo secret (automation token, publish scope).
- [ ] Confirm the `usrcp-*` package names are available / owned on npm.
- [ ] Run a full local dry run and inspect tarballs.
- [ ] Tag and let CI publish, or publish locally with `--execute`.
- [ ] After publish, flip the README install section from the source-build path
      to `npm i -g` / `npx`, and update the Homebrew adapter note.
