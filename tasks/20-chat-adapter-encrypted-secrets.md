# Encrypt Discord / Slack / Telegram secrets at rest

Date: 2026-05-17
Branch: `feat/chat-adapter-secrets-encrypted`
Follow-on to #54 ("Encrypt adapter refresh tokens + API keys at rest").

## Why

#54 encrypted the OAuth / API secrets for the three polling adapters
(google-calendar, gmail, linear). The chat adapters (discord, slack,
telegram) still wrote their bot tokens and the Anthropic API key
straight to `~/.usrcp/<adapter>-config.json` in plaintext.

Threat model is the same as #54: file mode 0600 stops one class of
attacker, but anything that reads the home directory (a misbehaving
shell extension, a backup tool, a process running under the same UID,
a stolen but unmounted disk where ACLs don't apply, a `cat` typo in a
support session) gets the bearer tokens in the clear. Encrypting under
the USRCP global key turns "got the file" into "still needs the
passphrase / dev-mode key file."

## Scope

| Adapter  | Sensitive fields encrypted                                            |
| -------- | --------------------------------------------------------------------- |
| discord  | `discord_bot_token`, `anthropic_api_key`                              |
| slack    | `slack_bot_token`, `slack_app_token`, `anthropic_api_key`             |
| telegram | `telegram_bot_token`, `anthropic_api_key`                             |

Each non-sensitive field (`allowlisted_channels` / `allowlisted_chats`,
`user_id`) stays plaintext - they're public-ish identifiers and
encrypting them would gain nothing while making config inspection
worse.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Re-use #54's pattern verbatim? | Yes - same envelope (`enc:<base64>`), same `deriveGlobalEncryptionKey(masterKey)` derivation | Cuts review surface to "where does the master key thread through" and reuses the audited helpers. |
| Bundle three adapters into one PR? | Yes | Identical mechanical change three times. Per-adapter PRs would be churn with no review benefit. |
| Cursor flush path for migration? | N/A - chat adapters have no cursor | Auto-migration fires on the next `loadConfig` instead. Idle adapters get migrated the moment the daemon restarts. |
| Wizard "Enter to keep" support? | Helper exported, wizards untouched | Discord / slack / telegram wizards are clean-slate prompt-everything flows today. `readPartialDecryptedConfig` is exported and tested so a future "edit one field" wizard can plug straight in. |
| `runSlackSetup` return type | Aligned to `Promise<SlackConfig>` | Matches discord / telegram / gcal / gmail / linear. Per [[feedback_usrcp_adapter_setup_return_type]]: align when next touched. |
| Discord / telegram `loadOrInitConfig` legacy shim | Left in place | Out of scope and still TTY-only. Carries no live callers but I didn't want to expand the PR with unrelated deletion. |

## Surface area

- `packages/usrcp-discord/src/config.ts` - encrypt-on-write + decrypt-on-load + auto-migrate-on-load.
- `packages/usrcp-discord/src/setup.ts` - `runDiscordSetup({ masterKey })`; fails fast if missing.
- `packages/usrcp-discord/src/index.ts` - Ledger constructed before `loadConfig(masterKey)`.
- Same shape for `packages/usrcp-slack/*` and `packages/usrcp-telegram/*`.
- `packages/usrcp-local/src/setup.ts` - `ADAPTERS_REQUIRING_MASTER_KEY` now includes `discord`, `slack`, `telegram` so the standalone `usrcp setup --adapter=<name>` path unlocks the master key before invoking the wizard.
- New tests:
  - `packages/usrcp-discord/src/__tests__/config.test.ts` (8 tests)
  - `packages/usrcp-slack/src/__tests__/config.test.ts` (8 tests)
  - `packages/usrcp-telegram/src/__tests__/config.test.ts` (8 tests)
  - Existing `packages/usrcp-local/src/__tests__/setup.test.ts` discord/telegram round-trip tests updated to pass a `masterKey`.

## Verification

- `(cd packages/usrcp-discord && npm test)` -> 35/35 pass
- `(cd packages/usrcp-slack && npm test)` -> 42/42 pass
- `(cd packages/usrcp-telegram && npm test)` -> 43/43 pass
- `(cd packages/usrcp-local && npm test)` -> 413/413 pass

## Out of scope

- iMessage adapter. It has no Anthropic key today (read-only capture
  via macOS chat.db) and no bot token. If a future revision adds an
  outbound LLM call, it gets the same treatment then.
- Re-encrypting on master-key rotation. Still listed as a follow-up
  from #54; not scoped here.
- Wizards-with-defaults. Could refactor the chat wizards to support
  "Enter to keep existing X" by reading `readPartialDecryptedConfig`
  on entry; today they prompt for everything. Helper is exported so
  the future change is mechanical.
