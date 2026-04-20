import initSqlJs, { Database as SqliteDatabase } from 'sql.js';

export interface LedgerConfig {
  mode: 'random' | string;
  autoMonitor?: boolean;
  channels?: string[];
  pollIntervalMs?: number;
  discordBotToken?: string;
  guildId?: string;
  channelIds?: string[];
  messageTool?: (params: any) => Promise<any>;
}

export interface Event {
  type: string;
  data: any;
}

export interface Ledger {
  appendEvent(stream: string, event: Event): void;
  getState(stream: string): any;
  entryCount: number;
}

class USRCPLedger implements Ledger {
  private db: SqliteDatabase;
  public entryCount: number = 0;

  constructor(db: SqliteDatabase) {
    this.db = db;
    
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Initialize entry count
    const countStmt = this.db.prepare('SELECT COUNT(*) FROM events');
    const countRow = countStmt.get() as [number];
    this.entryCount = countRow ? countRow[0] : 0;
  }

  appendEvent(stream: string, event: Event): void {
    const stmt = this.db.prepare(
      'INSERT INTO events (stream, type, data) VALUES (?, ?, ?)'
    );
    stmt.run([stream, event.type, JSON.stringify(event.data)]);
    stmt.free();
    const countStmt = this.db.prepare('SELECT COUNT(*) FROM events');
    const countRow = countStmt.get() as [number];
    this.entryCount = countRow ? countRow[0] : 0;
    countStmt.free();
  }

  getState(stream: string): any {
    if (this.entryCount > 1000) {
      throw new Error('Free tier limit exceeded: maximum 1000 entries allowed');
    }
    const stmt = this.db.prepare(
      'SELECT type, data FROM events WHERE stream = ? ORDER BY id ASC'
    );
    stmt.bind([stream]);
    const events: {type: string, data: string}[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as {type: string, data: string};
      events.push(row);
    }
    stmt.free();

    let state: any = {};
    for (const ev of events) {
      const data = JSON.parse(ev.data);
      switch (ev.type) {
        case 'init':
          state = { ...state, ...data };
          break;
        default:
          if (!state[ev.type]) {
            state[ev.type] = [];
          }
          state[ev.type].push(data);
      }
    }
    return state;
  }
}

export async function initLedger(config: LedgerConfig): Promise<Ledger> {
  const Sqlite = await initSqlJs();
  const db = new Sqlite.Database();
  const ledger = new USRCPLedger(db);
  // entryCount already 0 for new in-memory DB
  if (config.autoMonitor) {
    let lastPollTime = Date.now();
    const intervalMs = config.pollIntervalMs || 60000;
    const setupMonitoring = async () => {
      const poll = async () => {
        if (config.channels?.includes('discord')) {
          if (config.messageTool) {
            // Use OpenClaw message tool
            for (const channelId of (config.channelIds || [])) {
              const params = {
                action: "read",
                target: channelId,
                limit: 50,
                after: lastPollTime.toString(), // approximate ms
                includeArchived: false
              } as any; // since after expects string
              try {
                const result = await config.messageTool(params);
                const messages = (result as any).messages || [];
                for (const msg of messages) {
                  const msgTime = new Date(msg.timestamp || msg.createdAt || Date.now());
                  if (msg.author && !msg.author.bot && msgTime > new Date(lastPollTime)) {
                    ledger.appendEvent('cross_channel_messages', {
                      type: 'discord_message',
                      data: {
                        channelId,
                        authorId: msg.author.id,
                        content: msg.content,
                        timestamp: msgTime.toISOString()
                      }
                    });
                  }
                }
              } catch (e) {
                console.error('Poll error:', e);
              }
            }
          } else if (config.discordBotToken && config.guildId && config.channelIds) {
            // Use Discord.js
            const { Client, GatewayIntentBits } = await import('discord.js');
            const client = new Client({
              intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
              ]
            });
            await client.login(config.discordBotToken);
            const pollDiscord = async () => {
              try {
                const guild = client.guilds.cache.get(config.guildId);
                if (!guild) return;
                for (const channelId of config.channelIds) {
                  const channel = guild.channels.cache.get(channelId);
                  if (channel?.isTextBased()) {
                    const fetched = await channel.messages.fetch({ limit: 100 });
                    const newMsgs = fetched.filter(msg => new Date(msg.createdAt) > new Date(lastPollTime) && !msg.author.bot);
                    for (const [id, msg] of newMsgs) {
                      ledger.appendEvent('cross_channel_messages', {
                        type: 'discord_message',
                        data: {
                          channelId: msg.channel.id,
                          authorId: msg.author.id,
                          username: msg.author.username,
                          content: msg.content,
                          timestamp: msg.createdAt.toISOString()
                        }
                      });
                    }
                  }
                }
              } catch (e) {
                console.error('Discord poll error:', e);
              } finally {
                lastPollTime = Date.now();
              }
            };
            setInterval(pollDiscord, intervalMs);
            await pollDiscord(); // initial poll
            // Store client to prevent GC
            (ledger as any)._discordClient = client;
          }
        }
      };
      setInterval(poll, intervalMs);
      await poll(); // initial
    };
    await setupMonitoring();
  }
  return ledger;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required: string[];
    };
  };
}

export function openaiToolSchema(): OpenAITool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'appendEvent',
        description: 'Append an event to a USRCP ledger stream using usrcp://ledger/appendEvent URI semantics.',
        parameters: {
          type: 'object',
          properties: {
            stream: { type: 'string', description: 'The ledger stream/domain name.' },
            type: { type: 'string', description: 'The event type.' },
            data: { type: 'object', description: 'The event data payload.' }
          },
          required: ['stream', 'type', 'data']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'getState',
        description: 'Retrieve the current state of a USRCP ledger stream using usrcp://ledger/getState URI semantics.',
        parameters: {
          type: 'object',
          properties: {
            stream: { type: 'string', description: 'The ledger stream/domain name.' }
          },
          required: ['stream']
        }
      }
    }
  ];
}

export function xaiToolSchema(): OpenAITool[] {
  // Alias to openaiToolSchema as Grok/xAI mirrors OpenAI tool format with usrcp:// URI support
  return openaiToolSchema();
}