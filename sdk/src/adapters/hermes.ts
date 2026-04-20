import { EventEmitter } from 'events';
import type { USRCPAdapter, USRCPEvent } from './types';
import * as http from 'http';

export interface HermesAdapterConfig {
  /** Port to listen on for incoming webhooks (default: 0 = random) */
  port?: number;
  /** Path prefix for webhook endpoint (default: /webhook) */
  path?: string;
}

/**
 * Hermes adapter — listens for incoming webhooks via HTTP
 * and normalizes into {type:'webhook', data:payload, source:'hermes'}
 */
export class HermesAdapter extends EventEmitter implements USRCPAdapter {
  readonly name = 'hermes';
  private config: HermesAdapterConfig;
  private server?: http.Server;
  private _port: number = 0;

  constructor(config: HermesAdapterConfig = {}) {
    super();
    this.config = config;
  }

  /** The actual port the server bound to (available after start) */
  get port(): number {
    return this._port;
  }

  start(): void {
    const path = this.config.path || '/webhook';

    this.server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.startsWith(path)) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body);
            const event: USRCPEvent = {
              type: 'webhook',
              data: payload,
              source: 'hermes',
              timestamp: new Date().toISOString(),
            };
            this.emit('event', event);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400);
            res.end('Invalid JSON');
          }
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    this.server.listen(this.config.port || 0, () => {
      const addr = this.server!.address();
      this._port = typeof addr === 'object' && addr ? addr.port : 0;
    });
  }

  /** Manually push a webhook event (for testing / programmatic use) */
  push(payload: Record<string, any>): void {
    const event: USRCPEvent = {
      type: 'webhook',
      data: payload,
      source: 'hermes',
      timestamp: new Date().toISOString(),
    };
    this.emit('event', event);
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    this.removeAllListeners();
  }
}
