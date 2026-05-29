# usrcp-adapter-kit

Shared building blocks for [USRCP](https://github.com/frank-bot07/usrcp) capture adapters.

Today this is the **encrypted-at-rest config store** that every USRCP capture adapter (Linear, GitHub, Gmail, Google Calendar, Slack, Telegram, Discord, iMessage) builds on. It is the single deep-importer of `usrcp-local`'s encryption primitives — adapters depend on this kit rather than reaching into `usrcp-local` internals.

This is internal infrastructure for the USRCP adapter ecosystem; you generally install it transitively by installing an adapter, not directly.

## What it does

`createAdapterConfig()` takes a declarative field spec and returns a complete config store: AES-GCM secret encryption at rest (mode `0600`), atomic writes, a validate-or-exit gate, legacy-plaintext auto-migration, master-key rotation re-encryption, and debounced cursor persistence.

```ts
import { createAdapterConfig } from "usrcp-adapter-kit";

interface LinearConfig {
  linear_api_key: string;
  allowlisted_team_ids: string[];
  domain: string;
  poll_interval_s: number;
  last_synced_at?: string;
}

const store = createAdapterConfig<LinearConfig>({
  adapterName: "linear",
  filename: "linear-config.json",
  fields: [
    { name: "linear_api_key", kind: "secret" },
    { name: "allowlisted_team_ids", kind: "requiredNonEmptyArray" },
    { name: "domain", kind: "required" },
    { name: "poll_interval_s", kind: "requiredNumber" },
    { name: "last_synced_at", kind: "optional" },
  ],
  cursorFields: ["last_synced_at"],
});

// store.writeConfig / loadConfig / preflightConfig /
// reencryptConfigUnderNewKey / saveCursors / flushCursors / …
```

### Field kinds

| Kind | Meaning |
|------|---------|
| `secret` | Required, **encrypted at rest** under the USRCP global key |
| `required` | Required (truthy) |
| `requiredNumber` | Required, `typeof === "number"` |
| `requiredNonEmptyArray` | Required, non-empty array |
| `optional` | Not validated (cursors, optional allowlists); may declare a `default` |

## License

Apache-2.0
