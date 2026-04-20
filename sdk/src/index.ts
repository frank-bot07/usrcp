import { EventEmitter } from 'events';
import initSqlJs, { Database as SqliteDatabase } from 'sql.js';
import type { USRCPAdapter, USRCPEvent } from './adapters/types';

// Re-export adapter types and classes
export type { USRCPEvent, USRCPAdapter } from './adapters/types';
export { OpenClawAdapter } from './adapters/openclaw';
export type { OpenClawAdapterConfig } from './adapters/openclaw';
export { HermesAdapter } from './adapters/hermes';
export type { HermesAdapterConfig } from './adapters/hermes';
export { ClaudeAdapter } from './adapters/claude';
export type { ClaudeAdapterConfig } from './adapters/claude';
export { CodexAdapter } from './adapters/codex';
export type { CodexAdapterConfig } from './adapters/codex';

export interface LedgerConfig {
  mode?: 'random' | string;
  /** Adapters to auto-subscribe on init — events merge to 'global' stream */
  adapters?: USRCPAdapter[];
}

export interface Event {
  type: string;
  data: any;
}

export interface Ledger extends EventEmitter {
  appendEvent(stream: string, event: Event): void;
  getState(stream: string): any;
  entryCount: number;
  /** Stop all adapters and clean up */
  stop(): void;
}

class USRCPLedger extends EventEmitter implements Ledger {
  private db: SqliteDatabase;
  public entryCount: number = 0;
  private adapters: USRCPAdapter[] = [];

  constructor(db: SqliteDatabase) {
    super();
    this.db = db;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        source TEXT DEFAULT 'local',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const countStmt = this.db.prepare('SELECT COUNT(*) FROM events');
    const countRow = countStmt.get() as [number];
    this.entryCount = countRow ? countRow[0] : 0;
    countStmt.free();
  }

  appendEvent(stream: string, event: Event): void {
    const source = (event as any).source || 'local';
    const stmt = this.db.prepare(
      'INSERT INTO events (stream, type, data, source) VALUES (?, ?, ?, ?)'
    );
    stmt.run([stream, event.type, JSON.stringify(event.data), source]);
    stmt.free();
    this.entryCount++;
    // Emit on the ledger itself for downstream listeners
    this.emit('event', { stream, ...event, source });
  }

  getState(stream: string): any {
    if (this.entryCount > 1000) {
      throw new Error('Free tier limit exceeded: maximum 1000 entries allowed');
    }
    const stmt = this.db.prepare(
      'SELECT type, data, source FROM events WHERE stream = ? ORDER BY id ASC'
    );
    stmt.bind([stream]);
    const events: { type: string; data: string; source: string }[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { type: string; data: string; source: string };
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
          state[ev.type].push({ ...data, _source: ev.source });
      }
    }
    return state;
  }

  /** Subscribe an adapter — its events flow into the 'global' stream */
  addAdapter(adapter: USRCPAdapter): void {
    this.adapters.push(adapter);
    adapter.on('event', (evt: USRCPEvent) => {
      this.appendEvent('global', {
        type: evt.type,
        data: evt.data,
        source: evt.source,
      } as any);
    });
    adapter.start();
  }

  stop(): void {
    for (const adapter of this.adapters) {
      adapter.stop();
    }
    this.adapters = [];
    this.removeAllListeners();
  }
}

export async function initLedger(config: LedgerConfig = {}): Promise<Ledger> {
  const Sqlite = await initSqlJs();
  const db = new Sqlite.Database();
  const ledger = new USRCPLedger(db);

  // Auto-subscribe adapters on init — zero config
  if (config.adapters) {
    for (const adapter of config.adapters) {
      ledger.addAdapter(adapter);
    }
  }

  return ledger;
}

// Tool schema exports (unchanged API)
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
  return openaiToolSchema();
}
