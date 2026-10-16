# Adapter reliability audit and acceptance record

Status: in progress. These changes are not published and existing desktop connections have not been migrated. Do not use this record as an all-adapters launch certification.

## Findings and changes

- Some generated connections omitted the selected user profile. Adding another profile could stop startup or select an unintended default. OpenCode, OpenClaw, scoped MCP-agent and the Chrome native bridge now pin the selected profile. Capture adapters resolve an explicit or sole existing profile and reject ambiguity before opening a ledger.
- Setup could resolve an unrelated older USRCP executable from PATH. Terminal registrations now resolve this installation and use an absolute Node executable for JavaScript entrypoints. Init registration uses the same invocation helper. This does not yet guarantee that a versioned installation path survives removal during a future upgrade.
- Re-registering a connection could discard credentials and access restrictions. Terminal writers preserve host options, environment and scope/read-only restrictions, rejecting malformed restrictions. Backups containing credentials now use private permissions and unique names.
- Antigravity now uses `~/.gemini/config/mcp_config.json`, verified against current vendor documentation and the installed app's documentation. The adapter prefers that path when present and retains existing legacy IDE configurations.
- OpenCode registration did not handle its existing JSONC configuration. Registration/removal now preserve comments and unrelated servers and respect XDG_CONFIG_HOME.
- Capture-adapter configuration files were global across user profiles. Named profiles now use their own adapters directory. Existing default-profile paths remain compatible. Existing named-profile credentials in legacy global files need explicit reconfiguration; they must not be assigned to an arbitrary profile automatically.
- Adapter-kit configuration replacement now uses atomic, symlink-rejecting writes.
- Dependency updates address npm-reported advisories. All 17 Node package lockfiles plus the SDK lockfile report zero known vulnerabilities after the VS Code packaging-tool update. Production packed-consumer audit also reports zero known vulnerabilities. This is dependency evidence, not proof of absence of application vulnerabilities.
- `usrcp doctor [--probe]` distinguishes configuration errors from a successful MCP handshake and tool discovery. It does not read personal context and does not certify host behavior.
- `scripts/verify-adapter-install.mjs` installs real packed artifacts together in a fresh consumer, checks entrypoints, exercises shared-state protocol continuity, and audits production dependencies. CI now runs this separately from source tests, with platform-specific packages skipped only on unsupported OSes.

Code discovery used targeted source reads because graph tools were not exposed in this session. The review is bounded to adapter registration, profile/config handling, package installation and exercised continuity paths.

## Verification levels

A package passing install/build/unit tests is not a verified user experience. A successful MCP handshake does not establish automatic retrieval or capture in a particular host.

| Surface | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Claude Code | Real fresh-session write, retrieval and return recall through MCP | Desktop onboarding and ordinary encrypted profile |
| Codex CLI | Real fresh-session recall, correction and persistence through MCP | Desktop onboarding; default host approval experience |
| Cursor CLI | Isolated configuration created; CLI refused due to missing authentication | Authenticated CLI replay |
| Cursor native Agents app | Fresh-chat recall passed after correcting the stale global USRCP entry; get_state, status and handoff executed with one-time approvals | Capture/write and encrypted normal-profile rollout |
| Claude Desktop | Config generation and protocol logic reviewed | Native app fresh-context replay |
| OpenCode | 1.19.2 isolated install and fresh-session MCP recall passed | Installed 1.14.28 fails signature verification; normal install remains unchanged; write/restart tests pending |
| Antigravity | Native app fresh-chat recall passed after correcting profile and current config path; six read-only tools discovered | Encrypted normal-profile rollout and write/restart tests |
| Cline, Continue, Copilot CLI | Configuration writers covered by tests | Actual host onboarding and context replay for each |
| OpenClaw | Installed CLI supports native MCP registry; generated command fixed | Actual agent replay |
| Scoped MCP-agent | Generated invocation now pins profile and absolute runtime | Representative scoped-host replay |
| Discord, Telegram | Package build/tests/install pass | User supplied test destinations; existing encrypted credentials cannot be unlocked with available default/demo keys; fresh profile unlock unavailable |
| Slack, Gmail, Google Calendar, Linear, GitHub | Package build/tests/install pass | No dedicated service test destinations supplied |
| iMessage, Obsidian | Package build/tests/install pass | Isolated real-source capture and downstream retrieval |
| Chrome extension | Tests/build; native bridge profile binding fixed | Real browser capture and permissions; page-format changes remain a compatibility risk |
| VS Code extension | 15 unit tests and real VSIX packaging pass; pinned types to declared minimum host version | Actual installed extension activation and profile selection |
| Hermes | 61 Python tests pass | Actual Hermes conversation capture and fresh-host recall |
| Aider/file-based integration | File-oriented fallback | Does not meet the live no-file-handoff product promise |

Nine generated host configurations (including a fresh Claude Desktop init) passed MCP startup/tool discovery against isolated ledgers. This still does not count as nine native host acceptance passes.

The 17 Node package test suites passed after dependency/tooling repairs; cloud has three skipped tests and stream has two skipped tests in this local environment. PostgreSQL-backed coverage is a separate CI job. Local CLI suite now has 357 passing tests. Adapter-kit has 36; extension has 49; VS Code has 15.

## Real continuity experiment

Used one newly initialized synthetic profile isolated from personal memory. A unique fictional bakery scenario was introduced only to Claude Code. A fresh Codex session received only a generic recall question and correctly retrieved the project, pickup constraint and next step through USRCP. Codex received a changed pickup time without a recap, saved it, and a fresh Claude Code session recalled the correction and unchanged next step. Tool traces establish retrieval and writes through MCP.

Codex initially refused tool use under its approval policy. Explicit approvals were limited to tools on the synthetic test server for the successful run. This is a real onboarding issue to handle, not a reason to disable a user's global protections.

Antigravity then retrieved the same new scenario and corrected time in its native app, using `usrcp_get_state` after a one-time approval. Its final answer identified the original Claude planning and later Codex correction. Temporary test bindings were restored afterward.

This establishes retrieval across five hosts: Claude Code, Codex and OpenCode CLI sessions, plus native Cursor and Antigravity. Writes and correction persistence are verified in Claude Code and Codex only. This is not a five-app native UI demonstration or proof that every host automatically captures changes. Cursor's first native attempt failed and was stopped before accepting a file fallback. Correcting its global connection resolved the failure, and a new chat then retrieved the scenario and corrected time through get_state and handoff. OpenCode 1.14.28 failed signature verification; an isolated official 1.19.2 install worked. Its fresh-session test passed after explicitly setting the test working directory and passing the existing Google credential under the environment variable required by its provider. No global host installation was changed.

## Connection architecture

Keep one shared context service and the standard MCP interface. Bind the person's profile once during connection setup. Thin host integrations should configure that interface and provide tested capture/retrieval behavior. The user should not need to choose a project to answer "what was I just working on?"

MCP protocol negotiation reduces dependence on exact app versions. It cannot control host permissions, authentication, tool selection, configuration formats or UI-based capture. A managed HTTP endpoint may remove local executable-path problems for hosts that support it, but introduces authentication/service availability requirements and does not make host versions irrelevant. Maintain an explicit tested-host matrix and prevent unverified adapters from being marketed as seamless.

## Release gates still open

- Roll out the verified global Cursor and current Antigravity configurations to the chosen normal profile, upgrade the broken OpenCode host, and replay write/capture/restart behavior in every advertised host.
- Test Discord and Telegram after securely reconnecting test-bot credentials; keep other service adapters unverified until dedicated destinations exist.
- Verify encrypted-profile unlock, restart and upgrade behavior using a durable installation path. Capture adapters currently still depend on an environment passphrase for encrypted ledgers.
- Validate legacy named-profile config migration without credential loss or wrong-profile binding.
- Coordinate package version bumps and dependency minimums before publishing new core exports; no package has been published by this audit.
- Review changes and install released artifacts before upgrading the user's normal app connections. Code commit 812ec58 passed all 22 applicable PR checks, including PostgreSQL integrity and the fresh Linux packed-consumer job; the macOS-only CI job is skipped for PRs, with macOS package evidence from local runs.
