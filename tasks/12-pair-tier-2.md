# Task 12 - Multi-device pairing v2 (out-of-band secret)

**Repo:** `/Users/frankbot/usrcp/`.
**Branch:** `feat/pair-tier2-secret` (lands after #45 + #46).

## Why this exists

The v1 pairing flow (PR #45 + #46) shipped a one-shot pairing code
that doubled as both the cloud's lookup key AND the scrypt input for
bundle decryption. That meant the cloud held the decryption material
during the TTL window; anyone with row-level read access to
`pairing_bundles` (DB dump, log capturing the POST body, malicious
operator) could derive the key in a single scrypt call. The design
doc for #45 flagged this honestly and listed two tier-2 redesign
paths; this PR ships option 1.

## v2 design

User-facing pairing string:

```
<8 digit code>-<32 hex chars of 16 random bytes>
```

Displayed as six hyphen-separated groups:

```
1234-5678-aabbccdd-eeff0011-22334455-66778899
```

Parser is permissive: strips whitespace + hyphens and lowercases the
hex before validating `^[0-9]{8}[0-9a-f]{32}$`.

Key derivation:

```
key = HKDF-SHA256(IKM=secret, salt=utf8(code), info="usrcp-pairing-v2", L=32)
```

- `secret` (16 random bytes) is the actual encryption material; it
  travels device-to-device out of band (paste, QR, AirDrop, etc.) and
  never reaches the cloud.
- `code` is the 8-digit row lookup key sent to `/v1/pairing/init`.
- HKDF stretches a 128-bit-entropy secret to a 256-bit AES-GCM key.
  No scrypt cost is needed because the secret has more entropy than
  any practical brute-force budget.

Bundle JSON `schema_v` bumps from 1 -> 2. `pairJoin` rejects v1
bundles outright; this is a clean break (codes expire in <= 30 min).

## What the cloud sees in v2

- `code` (8 digits, plaintext, primary key)
- `encrypted_bundle` (AES-256-GCM ciphertext)
- `owner_public_key`, `expires_at`, `claim_attempts`, `created_at`
- The Ed25519 signature on the POST

It does NOT see the secret. Brute-forcing the secret is 2^128 work;
infeasible.

## Scope decisions (2026-05-16)

| Topic | Choice | Reason |
|---|---|---|
| Transport for the secret | Bundled into the printed pairing string | Single artifact to copy; works for paste, QR, AirDrop without extra UX. |
| Encoding | Lowercase hex | Familiar, zero edge cases, no extra dependency. Base32 would save 6 chars but needs an inline codec; not worth it at this length. |
| Secret length | 16 bytes (128 bits) | Far more than the 2^80-ish operational ceiling needs; matches AES-128 baseline. |
| KDF | HKDF-SHA256, no scrypt | Secret is high-entropy; no stretching needed. Code-as-salt prevents key reuse across distinct pairings if the same secret were ever (incorrectly) reused. |
| Schema versioning | Bump `schema_v` to 2; reject v1 | Clean break. Codes expire fast; no migration concerns. |
| `pair status` / `pair cancel` | Still take just the 8-digit code | Management endpoints don't need the secret; the row owner is already authenticated by Ed25519 signature. |
| CLI input parsing | Permissive: strips whitespace + hyphens, lowercases | Users will paste with line wraps, mixed case from screenshots, etc. |
| QR code | Out of scope | Plain-text only. QR rendering is a follow-up. |

## Threat model (v2)

The cloud is **no longer trusted with bundle plaintext.** Even a fully
compromised cloud (operator, DB dump, log scrape) cannot decrypt
pairing bundles without the out-of-band secret.

The user's responsibility is to keep the pairing string itself off
untrusted channels. A pairing string posted in public chat is as bad
as posting your master.salt + master.verify + encrypted private.pem
together; the recipient still needs the passphrase to actually unlock
the identity, but they have everything else they need to start
brute-forcing it. This was also true in v1; the only difference is
that v2 removes the cloud from the trust boundary.

### What v2 does NOT protect against

- A user who pastes the full pairing string into a public log or
  screenshot. The cloud is out of scope; the user's own clipboard
  hygiene is the limiting factor here.
- A trojaned `usrcp pair init` binary that exfiltrates the secret
  before printing it. Supply-chain risk; orthogonal to this design.

## Surface area added / changed

- `packages/usrcp-local/src/encryption.ts`: new `deriveFromPairingSecret(code, secret)` using HKDF-SHA256. Old `deriveFromPairingCode` + `FIXED_PAIRING_SALT` retained as dead code for one more cycle to avoid breaking external test imports; can be deleted in a follow-up cleanup.
- `packages/usrcp-local/src/pair.ts`: schema_v bumped to 2; pairInit returns `{ code, pairingString, expires_at }`; pairJoin takes the full pairing string; `formatPairingString` + `parsePairingString` helpers.
- `packages/usrcp-local/src/index.ts`: CLI prints the pairing string and reads it back permissively; `pair status` / `pair cancel` still take the 8-digit code.
- `packages/usrcp-local/src/__tests__/pair.test.ts`: 18 tests including a positive assertion that the secret hex does NOT appear in the POST body to the server.
- `packages/usrcp-stream/src/__tests__/pair-integration.test.ts`: integration test now asserts the secret does NOT appear in any column of the `pairing_bundles` row.
- Both READMEs + this decision doc.

The server-side code (`packages/usrcp-cloud/src/pairing.ts`, schema, routes) is unchanged. v2 is an entirely client-side cryptographic upgrade.

## Verification

```bash
(cd packages/usrcp-cloud  && npm run build && npm test)   # 55 tests
(cd packages/usrcp-local  && npm run build && npm test)   # 390 tests (+5)
(cd packages/usrcp-stream && npm run build && npm test)   # 106 tests
```

All three suites green as of the branch tip. The integration test
asserts that the 16-byte secret half of the pairing string does not
appear in any column of the `pairing_bundles` row.

## Out of scope (this PR)

- QR-code rendering / scanning.
- Identity rotation / revocation.
- Per-device subkeys.
- Removing the dead `deriveFromPairingCode` + `FIXED_PAIRING_SALT` exports (cleanup PR).
