import { initLedger, OpenClawAdapter, HermesAdapter, ClaudeAdapter, CodexAdapter } from '../src/index';
import type { USRCPEvent, Ledger } from '../src/index';

async function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  PASS: ${msg}`);
}

async function testCrossAppSync() {
  console.log('\n--- Test: Cross-app sync via adapters ---');

  const openclaw = new OpenClawAdapter();
  const hermes = new HermesAdapter();
  const claude = new ClaudeAdapter();
  const codex = new CodexAdapter();

  const ledger = await initLedger({
    adapters: [openclaw, hermes, claude, codex],
  });

  // Collect events emitted on the ledger
  const received: any[] = [];
  ledger.on('event', (evt: any) => received.push(evt));

  // Push events from each adapter
  openclaw.push({ content: 'hello from openclaw', channel: '#general', sender: 'frank' });
  hermes.push({ action: 'deploy', service: 'api', version: '1.2.3' });
  claude.push({ prompt: 'explain USRCP', response: 'USRCP is a protocol...' });
  codex.push({ id: 'sess-42', events: [{ action: 'file_edit', path: 'src/index.ts' }] });

  await assert(received.length === 4, `4 events received on ledger (got ${received.length})`);
  await assert(received[0].source === 'openclaw', 'first event from openclaw');
  await assert(received[1].source === 'hermes', 'second event from hermes');
  await assert(received[2].source === 'claude', 'third event from claude');
  await assert(received[3].source === 'codex', 'fourth event from codex');

  // Verify all merged into global stream
  const state = ledger.getState('global');
  await assert(Array.isArray(state.message), 'global state has message events');
  await assert(Array.isArray(state.webhook), 'global state has webhook events');
  await assert(Array.isArray(state.completion), 'global state has completion events');
  await assert(Array.isArray(state.session), 'global state has session events');

  // Verify source tracking
  await assert(state.message[0]._source === 'openclaw', 'message source tracked');
  await assert(state.webhook[0]._source === 'hermes', 'webhook source tracked');
  await assert(state.completion[0]._source === 'claude', 'completion source tracked');
  await assert(state.session[0]._source === 'codex', 'session source tracked');

  await assert(ledger.entryCount === 4, `entryCount is 4 (got ${ledger.entryCount})`);

  ledger.stop();
  console.log('--- Cross-app sync: ALL PASSED ---');
}

async function testGetStateRecall() {
  console.log('\n--- Test: getState recall across sources ---');

  const openclaw = new OpenClawAdapter();
  const claude = new ClaudeAdapter();

  const ledger = await initLedger({ adapters: [openclaw, claude] });

  // Simulate multiple messages from openclaw
  openclaw.push({ content: 'msg1', channel: '#dev' });
  openclaw.push({ content: 'msg2', channel: '#dev' });
  claude.push({ prompt: 'summarize', response: 'done' });

  const state = ledger.getState('global');
  await assert(state.message.length === 2, `2 messages in state (got ${state.message.length})`);
  await assert(state.completion.length === 1, `1 completion in state (got ${state.completion.length})`);
  await assert(state.message[0].content === 'msg1', 'first message content correct');
  await assert(state.message[1].content === 'msg2', 'second message content correct');
  await assert(state.completion[0].prompt === 'summarize', 'completion prompt correct');

  ledger.stop();
  console.log('--- getState recall: ALL PASSED ---');
}

async function testOpenClawToolHook() {
  console.log('\n--- Test: OpenClaw tool hook wrapping ---');

  const calls: any[] = [];
  const mockMessageTool = async (params: any) => {
    calls.push(params);
    return { ok: true, messageId: '123' };
  };

  const config = { messageTool: mockMessageTool };
  const openclaw = new OpenClawAdapter(config);

  const events: USRCPEvent[] = [];
  openclaw.on('event', (evt: USRCPEvent) => events.push(evt));
  openclaw.start();

  // Call the wrapped tool
  const result = await config.messageTool({ content: 'test', target: '#general' });
  await assert(result.ok === true, 'original tool result preserved');
  await assert(calls.length === 1, 'original tool was called');
  await assert(events.length === 1, 'event emitted on hook');
  await assert(events[0].type === 'message', 'event type is message');
  await assert(events[0].data.content === 'test', 'event data.content correct');
  await assert(events[0].source === 'openclaw', 'event source is openclaw');

  openclaw.stop();
  console.log('--- OpenClaw tool hook: ALL PASSED ---');
}

async function testHermesWebhookPush() {
  console.log('\n--- Test: Hermes webhook push ---');

  const hermes = new HermesAdapter();
  const events: USRCPEvent[] = [];
  hermes.on('event', (evt: USRCPEvent) => events.push(evt));
  hermes.start();

  // Use programmatic push (HTTP tested separately if needed)
  hermes.push({ action: 'ci_complete', repo: 'usrcp', status: 'success' });

  await assert(events.length === 1, 'webhook event received');
  await assert(events[0].type === 'webhook', 'type is webhook');
  await assert(events[0].data.action === 'ci_complete', 'payload preserved');

  hermes.stop();
  console.log('--- Hermes webhook: ALL PASSED ---');
}

async function testZeroConfig() {
  console.log('\n--- Test: Zero-config init (no adapters) ---');

  const ledger = await initLedger();
  ledger.appendEvent('test', { type: 'ping', data: { msg: 'hello' } });
  const state = ledger.getState('test');
  await assert(Array.isArray(state.ping), 'manual append still works');
  await assert(state.ping[0].msg === 'hello', 'data correct');
  await assert(ledger.entryCount === 1, 'entryCount correct');

  ledger.stop();
  console.log('--- Zero-config: ALL PASSED ---');
}

async function main() {
  console.log('=== USRCP v0.3.0 Test Suite ===');
  try {
    await testCrossAppSync();
    await testGetStateRecall();
    await testOpenClawToolHook();
    await testHermesWebhookPush();
    await testZeroConfig();
    console.log('\n=== ALL TESTS PASSED ===\n');
  } catch (e: any) {
    console.error('\n!!! TEST FAILURE !!!');
    console.error(e.message);
    process.exit(1);
  }
}

main();
