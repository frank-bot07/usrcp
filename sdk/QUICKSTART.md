# USRCP Quickstart v0.3.0

## Install
```bash
npm i usrcp-sdk
```

## Init Ledger (Zero-Config)
```ts
import { initLedger } from 'usrcp-sdk';

const config = {
  dbPath: './usrcp-ledger.db',
  adapters: [
    { type: 'openclaw', token: 'your-openclaw-token' },
    { type: 'hermes', webhookUrl: 'https://your-hermes-webhook' },
    { type: 'claude', apiKey: 'sk-claude-key' },
    { type: 'codex', apiKey: 'sk-codex-key' }
  ]
};

const ledger = await initLedger(config);
// Auto-subscribes adapters, merges events to 'global' stream
```

## Append Event (e.g., Manual)
```ts
await ledger.appendEvent('global', { type: 'user_message', data: { content: 'Test', sender: 'Chad' } });
```

## Recall Cross-App Context
```ts
const state = await ledger.getState('global');
// Returns reduced events from all adapters (OpenClaw sessions + Hermes webhooks + Claude completions + Codex streams)
console.log(state); // { messages: [...], completions: [...], ... }
```

## Test Mock Sync
Run `npm test`—verifies multi-app merge (e.g., OpenClaw message + Claude response recall).

Extensible: Add custom adapter class for new apps. No polling—pure events.

For ship: Run full tests, audit adapters, update CHANGELOG. Questions? Ping.