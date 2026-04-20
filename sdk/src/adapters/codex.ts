import { EventEmitter } from 'events';
import type { USRCPAdapter, USRCPEvent } from './types';

export interface CodexAdapterConfig {
  /** Hook into session event emissions */
  sessionHook?: (params: any) => Promise<any>;
}

/**
 * Codex adapter — hooks session event emissions
 * and normalizes into {type:'session', data:{id, events}, source:'codex'}
 */
export class CodexAdapter extends EventEmitter implements USRCPAdapter {
  readonly name = 'codex';
  private config: CodexAdapterConfig;
  private _origSessionHook?: (params: any) => Promise<any>;

  constructor(config: CodexAdapterConfig = {}) {
    super();
    this.config = config;
  }

  start(): void {
    if (this.config.sessionHook) {
      this._origSessionHook = this.config.sessionHook;
      const self = this;
      this.config.sessionHook = async function wrappedSessionHook(params: any) {
        const result = await self._origSessionHook!(params);
        const event: USRCPEvent = {
          type: 'session',
          data: {
            id: params.sessionId || params.id || 'unknown',
            events: Array.isArray(result) ? result : [result],
          },
          source: 'codex',
          timestamp: new Date().toISOString(),
        };
        self.emit('event', event);
        return result;
      };
    }
  }

  /** Manually push a session event */
  push(data: { id: string; events: any[] }): void {
    const event: USRCPEvent = {
      type: 'session',
      data: {
        id: data.id,
        events: data.events,
      },
      source: 'codex',
      timestamp: new Date().toISOString(),
    };
    this.emit('event', event);
  }

  stop(): void {
    if (this._origSessionHook) {
      this.config.sessionHook = this._origSessionHook;
    }
    this.removeAllListeners();
  }
}
