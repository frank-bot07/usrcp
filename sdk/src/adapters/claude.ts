import { EventEmitter } from 'events';
import type { USRCPAdapter, USRCPEvent } from './types';

export interface ClaudeAdapterConfig {
  /** Wrap an API completion function to intercept calls */
  completionFn?: (params: any) => Promise<any>;
}

/**
 * Claude adapter — hooks API completion calls
 * and normalizes into {type:'completion', data:{prompt, response}, source:'claude'}
 */
export class ClaudeAdapter extends EventEmitter implements USRCPAdapter {
  readonly name = 'claude';
  private config: ClaudeAdapterConfig;
  private _origCompletionFn?: (params: any) => Promise<any>;

  constructor(config: ClaudeAdapterConfig = {}) {
    super();
    this.config = config;
  }

  start(): void {
    if (this.config.completionFn) {
      this._origCompletionFn = this.config.completionFn;
      const self = this;
      this.config.completionFn = async function wrappedCompletion(params: any) {
        const result = await self._origCompletionFn!(params);
        const event: USRCPEvent = {
          type: 'completion',
          data: {
            prompt: params.prompt || params.messages || params,
            response: result,
          },
          source: 'claude',
          timestamp: new Date().toISOString(),
        };
        self.emit('event', event);
        return result;
      };
    }
  }

  /** Manually push a completion event */
  push(data: { prompt: any; response: any }): void {
    const event: USRCPEvent = {
      type: 'completion',
      data: {
        prompt: data.prompt,
        response: data.response,
      },
      source: 'claude',
      timestamp: new Date().toISOString(),
    };
    this.emit('event', event);
  }

  stop(): void {
    if (this._origCompletionFn) {
      this.config.completionFn = this._origCompletionFn;
    }
    this.removeAllListeners();
  }
}
