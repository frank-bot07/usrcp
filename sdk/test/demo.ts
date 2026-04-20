import { initLedger } from '../dist/index.js';

async function runTest() {
  const ledger = await initLedger({ mode: 'random' });

  ledger.appendEvent('test', { type: 'init', data: { hello: 'world' } });

  let state = ledger.getState('test');
  console.log('SDK Test:', state, 'Entry count:', ledger.entryCount);

  console.log('\nTesting free tier limit...');
  for (let i = 1; i <= 999; i++) {
    ledger.appendEvent('test', { type: `event${i}`, data: { value: i } });
  }

  console.log('Appended 999 events after init. Total entry count:', ledger.entryCount);

  try {
    state = ledger.getState('test');
    console.log('State after 1000 total events (should succeed):', state);
  } catch (error: unknown) {
    const err = error as Error;
    console.log('Unexpected error after 1000 events:', err.message);
  }

  ledger.appendEvent('test', { type: 'event1000', data: { value: 1000 } });
  console.log('Appended 1000th event after init. Total entry count:', ledger.entryCount);

  try {
    state = ledger.getState('test');
    console.log('State after 1001 total events (should error):', state);
  } catch (error: unknown) {
    const err = error as Error;
    console.log('Free tier limit hit on 1001st getState:', err.message);
  }
}

runTest().catch((error: unknown) => {
  const err = error as Error;
  console.error('Test failed:', err.message);
});
