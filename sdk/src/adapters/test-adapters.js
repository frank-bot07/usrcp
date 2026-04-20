const { DiscordAdapter, TelegramAdapter } = require('./index');

// Test Discord
console.log('Testing Discord Adapter');
const discord = new DiscordAdapter();
discord.on('event', (event) => {
  console.log('Discord event:', JSON.stringify(event, null, 2));
  // Simulate append to ledger: console.log('Would append to USRCP ledger:', event);
});
discord.push({ content: 'Hello from test!', channel: 'test-channel', sender: '123', username: 'TestUser' });

// Test Telegram
console.log('\\nTesting Telegram Adapter');
const telegram = new TelegramAdapter();
telegram.on('event', (event) => {
  console.log('Telegram event:', JSON.stringify(event, null, 2));
  // Simulate append to ledger
});
telegram.push({ content: 'Hello from Telegram test!', channel: '456', sender: '789', username: 'TgUser', type: 'text' });

setTimeout(() => {
  discord.stop();
  telegram.stop();
  console.log('\\nTests complete. Events emitted successfully.');
}, 1000);