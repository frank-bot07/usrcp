# usrcp-obsidian

Obsidian capture adapter for USRCP. Watches a local Obsidian vault for
note edits and appends them to the USRCP ledger as encrypted timeline
events. Capture-only — no reader/bot, no Anthropic key needed.

## Install and run

```bash
cd packages/usrcp-obsidian
npm install
npm run build
node dist/index.js                  # watch loop
node dist/index.js --reset-config   # re-prompt all config
```

First run is interactive: detects vaults under common locations
(`~/Documents`, `~/Notes`, `~/Obsidian`, `~/Vaults`), then prompts for
subdirectory and tag filters, the target USRCP domain, and a debounce
interval. The watcher uses `chokidar` for cross-platform fs events.

## Where secrets live

There are no secrets; just config at `~/.usrcp/obsidian-config.json`:

```json
{
  "vault_path": "/Users/.../Obsidian/Personal",
  "allowed_subdirs": ["Daily", "Projects"],
  "excluded_subdirs": ["Templates"],
  "allowed_tags": ["#work"],
  "excluded_tags": ["#private"],
  "domain": "work",
  "debounce_ms": 2000
}
```

Tag filters are matched against frontmatter `tags:` and inline
`#tag` mentions; subdir filters match path segments relative to the
vault root.

## What lands in the ledger

Each debounced edit becomes a `timeline_events` row:

- `channel_id` — `obsidian:<vault-name>:<relative-path>`
- Note title and body encrypted under the global key
