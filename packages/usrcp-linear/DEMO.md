# USRCP Linear — End-to-End Demo

> **Most users want `usrcp setup --adapter=linear` instead.** This is the manual proof script for the Linear adapter — what the wizard automates, plus a smoke test you can re-run after any change.

What this walkthrough proves:

> **An issue or comment you author in an allowlisted Linear team lands as a structured ledger event within one poll interval, and is retrievable through the MCP server.**

The adapter is **capture-only** (no reader, no bot). Capture is the only criterion.

---

## Prereqs

- USRCP core installed and `usrcp init` already run.
- A **Linear personal API key**. Generate one at [linear.app/settings/api](https://linear.app/settings/api) → **Personal API keys** → **Create key**. The key starts with `lin_api_…`. Treat it as a secret; it grants access to whatever Linear sees as you.

That's it — no OAuth client, no Cloud Console.

---

## Setup (one-time, ~1 minute)

```bash
cd packages/usrcp-linear
npm install
npm run build

usrcp setup --adapter=linear
```

The wizard:
1. Prompts for `linear_api_key` (paste the `lin_api_…` value).
2. **Validates the key** against Linear's `viewer` GraphQL query before persisting — a bad key fails the wizard, not first poll.
3. Lists the teams visible to your key and lets you pick which to allowlist (comma-separated indices, or `all`).
4. Writes `~/.usrcp/linear-config.json` at mode `0600` with the API key sealed under the USRCP master key.

---

## The proof walkthrough

```bash
# Tail 1: the poller (leave running)
USRCP_PASSPHRASE="your-passphrase" usrcp-linear
```

```bash
# Tail 2: query the ledger
USRCP_PASSPHRASE="your-passphrase" usrcp recent --domain=work --limit=5
```

(Substitute `work` with whatever `domain` you set in the wizard.)

Now:

1. **In Linear**, in one of your allowlisted teams, create a new issue titled `usrcp demo proof` with any description.
2. Add a comment on that issue ("smoke test comment").
3. Wait for the next poll tick (default `poll_interval_s` is 600s — bump to 60 in `~/.usrcp/linear-config.json` for a snappier demo).
4. The poller logs each tick that captures or skips events.
5. Re-run `usrcp recent --domain=work` — you should see two new events:
   - `intent: issue_opened` (the issue), `channel_id: <issue-id>`
   - `intent: comment_posted` (the comment), `channel_id: <issue-id>` (same issue id, so the thread groups)

If both events appear, capture is proven end-to-end. ✅

---

## What this does NOT prove

- **Events authored by others** — only events whose `creator` is you (the viewer of the API key) are captured.
- **Teams outside the allowlist** — issues + comments in unselected teams are skipped server-side via the GraphQL filter.
- **Status changes, assignments, project moves** — v0 captures issues and comments; structural state changes are out of scope.

---

## Troubleshooting

- **Wizard rejects API key** — the key is wrong or revoked. Generate a fresh one at [linear.app/settings/api](https://linear.app/settings/api).
- **"master key missing"** — run via `usrcp setup --adapter=linear`, not the wizard standalone.
- **Tick fires but never captures** — confirm you're the *author* of the issue/comment, not just the assignee. The capture filter narrows to events you created.
- **Wrong team's events captured / missed** — re-run `usrcp setup --adapter=linear` and update `allowlisted_team_ids`.
- **Passphrase needed**: if `usrcp init` was passphrase-mode, the poller needs `USRCP_PASSPHRASE` in its env.
