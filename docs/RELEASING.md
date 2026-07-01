# Releasing USRCP

This covers the two rails that matter for a normal release: the **npm publish
rail** (the TypeScript/Node packages) and the **Homebrew rail** (the `usrcp`
CLI), documented in the [Homebrew section](#homebrew-the-usrcp-cli-tap) below.
The Homebrew rail is downstream of npm and now self-syncs — on a normal release
you do nothing for it. The VS Code extension and the Python `usrcp-hermes`
package ship through their own channels.

## What gets published

`scripts/release/publish.mjs` owns the package list (`PUBLISH_ORDER`) and the
dependency-ordered publish. Today that is:

| Tier | Packages |
|------|----------|
| 0 | `usrcp-core` (the framework-agnostic protocol core; everything below depends on it) |
| 1 | `usrcp-local` |
| 2 | `usrcp-adapter-kit`, `usrcp-stream` |
| 3 | `usrcp-obsidian`, `usrcp-linear`, `usrcp-github`, `usrcp-gmail`, `usrcp-google-calendar`, `usrcp-discord`, `usrcp-telegram`, `usrcp-slack`, `usrcp-imessage`, `usrcp-claude-code`, `usrcp-extension` |

**Excluded by design:** `usrcp-cloud` (hosted server, deployed not installed),
`usrcp-vscode` (VS Code marketplace), `usrcp-hermes` (pip).

## How the file: → versioned dep bridge works

In the repo, packages depend on each other via `file:../usrcp-core` etc. so each
stays independently installable/buildable (the per-package CI matrix relies on
this — there is no workspace root). Those `file:` specs can't be published.
(The Homebrew formula does **not** rely on these — it installs the published npm
tarball; see the [Homebrew section](#homebrew-the-usrcp-cli-tap).)

The release script bridges the two **only at release time**:

1. Verifies the git tree is clean.
2. Builds every package in dependency order.
3. Rewrites each `file:../usrcp-<x>` dep to `^<that package's version>`.
4. `npm pack` (dry-run) or `npm publish` (`--execute`) in dependency order.
5. Restores the rewritten `package.json` files via `git checkout` — always,
   even on failure — so the working tree never keeps the rewritten specs.

Because the rewrite is confined to the release script, day-to-day dev and the CI
test matrix are untouched. (Homebrew is unaffected either way — it installs the
already-published npm tarball, not a source build of this repo.)

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

Requires an npm token with publish rights to the `usrcp-*` names — a granular
token scoped to **All packages / Read and write** (classic Automation also
works if your account still offers it) — exposed as `NODE_AUTH_TOKEN` (CI reads
the `NPM_TOKEN` repo secret). This is the token path; the Trusted Publishing
section below is the eventual token-free upgrade.

**Via CI (preferred):** push a version tag.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/publish.yml` runs the dry-run pack, then publishes. It can
also be run manually from the Actions tab (`execute: true`).

**Locally (fallback):**

```bash
npm whoami                                  # confirm you're authed
node scripts/release/publish.mjs --execute
```

## Trusted Publishing (OIDC) — token-free CI, with provenance

The workflow is wired for npm Trusted Publishing: it requests an OIDC
`id-token`, so once a package trusts this workflow, CI publishes it **without
the `NPM_TOKEN` secret** and attaches a signed **provenance** attestation
(the "Published via GitHub Actions" badge on npm). The token stays as a
fallback, so nothing breaks before OIDC is configured — each package upgrades
to OIDC the moment you set its trusted publisher.

**Chicken-and-egg:** trusted publishing can only be configured on a package
that already exists. So the sequence is:

1. **First publish** creates the names (token path — CI or local `--execute`).
2. For each published package, on npmjs.com:
   **Package → Settings → Publishing access → "Require two-factor… or
   automation/granular tokens" + Add trusted publisher** →
   - Publisher: **GitHub Actions**
   - Organization/user: `frank-bot07`
   - Repository: `usrcp`
   - Workflow filename: `publish.yml`
   - Environment: *(leave blank — the workflow uses none)*
3. After that, tag-triggered releases authenticate via OIDC; the `NPM_TOKEN`
   secret can eventually be removed once **all** packages are configured.

Requires npm CLI ≥ 11.5.1 in CI (the workflow's `npm install -g npm@latest`
covers it) and a **public** repo (provenance requires it — this repo is public).

> Note: this is the one release step that can't be dry-run locally — the OIDC
> handshake only happens inside GitHub Actions on a real tag/dispatch run.
> Verify it on the first tagged release after configuring a package (the run
> log shows `Provenance statement published` and the npm page shows the
> provenance badge).

## Homebrew (the `usrcp` CLI tap)

The `usrcp` command-line tool also ships via Homebrew: `brew install
frank-bot07/usrcp/usrcp`. This rail is **separate from and downstream of npm** —
it lives in its own repo and, on a normal release, **updates itself**.

- **Tap repo:** `frank-bot07/homebrew-usrcp` (not this repo). Formula:
  `Formula/usrcp.rb`.
- **The formula installs the published npm tarball**, not a source build of this
  repo: `url` is `https://registry.npmjs.org/usrcp-local/-/usrcp-local-X.Y.Z.tgz`
  and `sha256` is of that tarball. It resolves `usrcp-core` etc. from the
  registry, `depends_on "node"`, and rebuilds `better-sqlite3` (Homebrew's
  `std_npm_args` runs `--ignore-scripts`, so the package postinstall is skipped).
  This decouples brew from the monorepo's internal layout — refactors behind the
  public npm contract (e.g. the `usrcp-core` split) can't break the brew install.

- **Bumps are automated** by `.github/workflows/auto-bump.yml` in the tap — a
  daily poller (+ `workflow_dispatch`). Each run: if npm's latest `usrcp-local`
  is newer than the formula **and** has aged past the cooldown (below), it bumps
  `url`+`sha256`, **proves it with a real macOS `brew install` + `brew test`
  in-job**, opens a PR, and **auto-merges on green**. So a normal release needs
  **no manual brew step** — brew catches up on its own within ~a day.

- **The 1-day cooldown — the one non-obvious constraint.** Homebrew's `npm
  install` passes `--min-release-age=1`: it refuses any dependency published in
  the last ~24h (supply-chain protection). So a freshly published version is
  **not brew-installable until ~24h later** — its just-published `usrcp-core` is
  excluded. Brew therefore trails an npm release by ~1 day, by design. Don't try
  to `brew install`/verify a release you just published; the auto-bump waits it
  out (`MIN_AGE_HOURS=25`). **Do not bypass the cooldown** — it's a security
  feature (editing Homebrew's `release_cooldown.rb` is not a supported step).

- **Manual verify / fallback.** `.github/workflows/brew-test.yml` (tap,
  `workflow_dispatch`) runs `brew install` + `brew test` on `macos-latest`
  against any branch:
  ```bash
  gh workflow run brew-test.yml --repo frank-bot07/homebrew-usrcp --ref <branch>
  ```
  If you ever need to hand-edit the formula, recompute the sha with
  `curl -sL <npm tarball url> | shasum -a 256`. If an auto-bump run ever fails at
  the *merge* step (e.g. a branch-protection change), the bump + verification
  already succeeded — just merge the open PR once.

- **Don't use a claude.ai cloud routine to verify brew.** Those run on Linux
  (no Homebrew) and have no `gh` auth. macOS brew verification only works via the
  GitHub Actions workflows above.

## Versioning

All packages are released in lockstep at the same version (the `^` rewrite
assumes a coordinated release). Bump every publishable `package.json` to the new
version before tagging. (A future improvement: a `version` subcommand in the
release script to bump them together.)

## First publish checklist

- [ ] Add the `NPM_TOKEN` repo secret (granular token, All packages / read+write).
- [ ] Confirm the `usrcp-*` package names are available / owned on npm.
- [ ] Run a full local dry run and inspect tarballs.
- [ ] Tag and let CI publish, or publish locally with `--execute`.
- [ ] After publish, flip the README install section from the source-build path
      to `npm i -g` / `npx`, and update the Homebrew adapter note.
- [ ] (Optional, post-first-publish) Configure a trusted publisher per package
      for token-free OIDC + provenance; once all are set, drop `NPM_TOKEN`.
