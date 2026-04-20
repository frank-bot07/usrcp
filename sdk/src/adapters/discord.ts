import { EventEmitter } from 'events';
import { Client, GatewayIntentBits } from 'discord.js';
import type { USRCPAdapter, USRCPEvent } from './types';

export interface DiscordAdapterConfig {
  token?: string;
  ignoreBots?: boolean;
}

export class DiscordAdapter extends EventEmitter implements USRCPAdapter {
  readonly name = 'discord';
  private client: Client;
  private config: DiscordAdapterConfig;

  constructor(config: DiscordAdapterConfig = {}) {
    super();
    this.config = { ignoreBots: true, ...config };
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on('messageCreate', (message) => {
      if (this.config.ignoreBots && message.author.bot) return;
      const event: USRCPEvent = {
        type: 'message',
        data: {
          content: message.content,
          channel: message.channel.id,
          sender: message.author.id,
          username: message.author.username,
        },
        source: 'discord',
        timestamp: new Date().toISOString(),
      };
      this.emit('event', event);
    });

    this.client.on('ready', () => {
      console.log(`Discord adapter ready: ${this.client.user?.tag}`);
    });
  }

  start(token?: string): void {
    const actualToken = token || this.config.token || process.env.DISCORD_BOT_TOKEN;
    if (!actualToken) {
      throw new Error('Discord bot token is required (env: DISCORD_BOT_TOKEN or config.token)');
    }
    this.client.login(actualToken);
  }

  stop(): void {
    this.client.destroy();
    this.removeAllListeners();
  }

  /** Manually push an event for testing */
  push(data: { content: string; channel?: string; sender?: string; username?: string }): void {
    const event: USRCPEvent = {
      type: 'message',
      data: {
        content: data.content,
        channel: data.channel || 'test-channel',
        sender: data.sender || 'test-user',
        username: data.username || 'TestUser',
      },
      source: 'discord',
      timestamp: new Date().toISOString(),
    };
    this.emit('event', event);
  }
}