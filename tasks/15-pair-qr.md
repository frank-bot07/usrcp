# Task 15 - QR-code output for `usrcp pair init`

**Repo:** `/Users/frankbot/usrcp/`.
**Branch:** `feat/pair-qr` (lands after #49).

## Why this exists

The v2 pairing string (#47) is `<8 digit code>-<32 hex chars of 16
random bytes>`, e.g. `1234-5678-aabbccdd-eeff0011-22334455-66778899`.
That is 45 characters with hyphens - too long to dictate aloud, awkward
to type, and inconvenient to copy between two machines that don't
share a clipboard.

This PR prints a scannable ASCII QR of the pairing string in `usrcp
pair init`'s output. Users on the new device can point any QR reader
(phone camera, browser QR plugin) at the source device's terminal and
get the full string without typing.

## Scope decisions (2026-05-17)

| Topic | Choice | Reason |
|---|---|---|
| QR library | `qrcode-terminal` (small, no deps beyond stdlib) | Tiny well-known dep; renders directly to terminal with half-block characters. The full `qrcode` package pulls in pngjs / dijkstrajs which we don't need. |
| QR for `pair join` | Out of scope | Reading QR from images needs an image decoder + QR scanner (`jsqr`, etc.). Users can scan the source terminal's QR with their phone and paste the decoded string into the destination shell. |
| Default on | Yes; `--no-qr` to suppress | Most terminals (iTerm2, Terminal.app, GNOME Terminal, Windows Terminal) render Unicode half-blocks fine. `--no-qr` is the escape hatch for log capture or rendering-incompatible environments. |
| Test approach | Assert non-empty + contains block characters + multi-line + deterministic per input | The library itself is well-tested upstream; our tests confirm the integration is wired correctly. |

## Surface area

**New / changed:**

- `packages/usrcp-local/package.json`: adds `qrcode-terminal` (runtime) and `@types/qrcode-terminal` (dev).
- `packages/usrcp-local/src/pair.ts`: new `renderPairingQr(pairingString): string` helper that returns the QR rendering rather than printing (so the caller controls output stream + tests can capture).
- `packages/usrcp-local/src/index.ts`: `usrcp pair init` now prints the QR after the pairing string by default; `--no-qr` skips it.
- `packages/usrcp-local/src/__tests__/pair.test.ts`: 2 new tests (non-empty output with half-block chars + deterministic per input). Total 401 (+2).
- `packages/usrcp-local/README.md`: documents the QR output and `--no-qr` flag.

## Verification

```bash
(cd packages/usrcp-cloud  && npm run build && npm test)   # 75 unchanged
(cd packages/usrcp-local  && npm run build && npm test)   # 401 (+2)
(cd packages/usrcp-stream && npm run build && npm test)   # 107 unchanged
```

All three suites green.

Manual smoke (out of scope for the automated suite): `node dist/index.js
pair init` in a terminal and scan the QR with a phone camera; the
decoded string must round-trip with `parsePairingString` to recover
the same code + secret.

## Out of scope

- `usrcp pair join --qr=<image>` (image scanning side).
- QR for any other CLI surface (rotation, sync, etc.).
- Alternative encodings (data: URLs, screenshot helpers, etc.).
- Customising QR error-correction level or size.
