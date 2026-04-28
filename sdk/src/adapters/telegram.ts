import { EventEmitter } from 'events';
import { Telegraf } from 'telegraf';
import type { USRCPAdapter, USRCPEvent } from './types';

export interface TelegramAdapterConfig {
  token?: string;
  ignoreBots?: boolean;
}

export class TelegramAdapter extends EventEmitter implements USRCPAdapter {
  readonly name = 'telegram';
  // Constructed lazily in start() once we have the token, since Telegraf
  // requires a token at construction time and exposes `token` as readonly.
  private bot: Telegraf | null = null;
  private config: TelegramAdapterConfig;

  constructor(config: TelegramAdapterConfig = {}) {
    super();
    this.config = { ignoreBots: true, ...config };
  }

  private setupListeners(bot: Telegraf): void {
    bot.on('message', (ctx) => {
      if (this.config.ignoreBots && ctx.from?.is_bot) return;
      const message: any = ctx.message;
      let content = '';
      let msgType = 'unknown';
      if (typeof message.text === 'string') {
        content = message.text;
        msgType = 'text';
      } else if (typeof message.caption === 'string') {
        content = message.caption;
        msgType = message.photo ? 'photo' : message.document ? 'document' : 'caption';
      } else if (message.sticker) {
        content = `[Sticker: ${message.sticker.emoji || 'no-emoji'}]`;
        msgType = 'sticker';
      } else if (message.photo) {
        content = `[Photo]`;
        msgType = 'photo';
      } else {
        // Fall back to the first known media-type field present on the
        // discriminated union, otherwise just 'unknown'.
        const mediaKeys = ['video', 'audio', 'voice', 'document', 'animation'];
        const found = mediaKeys.find((k) => message[k]);
        msgType = found || 'unknown';
        content = `[${msgType}]`;
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
    this.bot = new Telegraf(actualToken);
    this.setupListeners(this.bot);
    this.bot.launch();
    console.log('Telegram adapter started');
  }

  stop(): void {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
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
