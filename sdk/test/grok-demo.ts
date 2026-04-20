import OpenAI from 'openai';
import { initLedger, xaiToolSchema } from '../src/index.js'; // Adjust path for source; use '../dist/index.js' after build

async function demoGrokIntegration() {
  // Initialize xAI client using OpenAI SDK compatibility
  const xai = new OpenAI({
    baseURL: 'https://api.x.ai/v1',
    apiKey: process.env.XAI_API_KEY,
  });

  // Initialize ledger
  const ledger = await initLedger({ mode: 'random' });

  // Get tools schema (reuses OpenAI format with usrcp:// URI semantics)
  const tools = xaiToolSchema();

  // Demo: Mock chat completion with tools (in production, await xai.chat.completions.create)
  console.log('Mocking chat completion call to Grok/xAI...');
  // Simulated response with tool call
  const mockCompletion = {
    choices: [{
      message: {
        tool_calls: [{
          function: {
            name: 'appendEvent',
            arguments: JSON.stringify({
              stream: 'chat',
              type: 'user_message',
              data: { content: 'Hello from Grok!' }
            })
          }
        }]
      }
    }]
  };

  // Process mock tool call
  if (mockCompletion.choices[0].message.tool_calls) {
    const toolCall = mockCompletion.choices[0].message.tool_calls[0];
    if (toolCall.function.name === 'appendEvent') {
      const args = JSON.parse(toolCall.function.arguments);
      ledger.appendEvent(args.stream, { type: args.type, data: args.data });

      // Get updated state
      const state = ledger.getState(args.stream);
      console.log('Appended event and updated state:', state);
      console.log('Entry count:', ledger.entryCount);
    }
  }
}

// Run demo
demoGrokIntegration().catch(console.error);
