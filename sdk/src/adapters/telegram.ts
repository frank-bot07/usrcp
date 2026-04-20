import { EventEmitter } from 'events';
import { Telegraf } from 'telegraf';
import type { USRCPAdapter, USRCPEvent } from './types';

export interface TelegramAdapterConfig {
  token?: string;
  ignoreBots?: boolean;
}

export class TelegramAdapter extends EventEmitter implements USRCPAdapter {
  readonly name = 'telegram';
  private bot: Telegraf;
  private config: TelegramAdapterConfig;

  constructor(config: TelegramAdapterConfig = {}) {
    super();
    this.config = { ignoreBots: true, ...config };
    this.bot = new Telegraf('');
    this.setupListeners();
  }

  private setupListeners(): void {
    this.bot.on('message', (ctx) => {
      if (this.config.ignoreBots && ctx.from?.is_bot) return;
      const message = ctx.message;
      let content = '';
      let msgType = 'unknown';
      if (message.text) {
        content = message.text;
        msgType = 'text';
      } else if (message.caption) {
        content = message.caption;
        msgType = message.type || 'photo'; // e.g., photo, document
      } else if (message.sticker) {
        content = `[Sticker: ${message.sticker.emoji || 'no-emoji'}]`;
        msgType = 'sticker';
      } else if (message.photo) {
        content = `[Photo]`;
        msgType = 'photo';
      } // add more as needed
      else {
        content = `[${message.type}]`;
        msgType = message.type;
      }

      const event: USRCPEvent = {
        type: 'message',
        data: {
          content,
          channel: ctx.chat.id.toString(),
          sender: ctx.from?.id?.toString() || '',
          username: ctx.from?.username || ctx.from?.first_name || '',
          type: msgType,
        },
        source: 'telegram',
        timestamp: new Date().toISOString(),
      };
      this.emit('event', event);
    });
  }

  start(token?: string): void {
    const actualToken = token || this.config.token || process.env.TELEGRAM_BOT_TOKEN;
    if (!actualToken) {
      throw new Error('Telegram bot token is required (env: TELEGRAM_BOT_TOKEN or config.token)');
    }
    this.bot.token = actualToken;
    this.bot.launch();
    console.log('Telegram adapter started');
  }

  stop(): void {
    this.bot.stop();
    this.removeAllListeners();
  }

  /** Manually push an event for testing */
  push(data: { content: string; channel?: string; sender?: string; username?: string; type?: string }): void {
    const event: USRCPEvent = {
      type: 'message',
      data: {
        content: data.content,
        channel: data.channel || 'test-chat',
        sender: data.sender || 'test-user',
        username: data.username || 'TestUser',
        type: data.type || 'text',
      },
      source: 'telegram',
      timestamp: new Date().toISOString(),
    };
    this.emit('event', event);
  }
}