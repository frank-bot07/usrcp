import { EventEmitter } from 'events';
import type { USRCPAdapter, USRCPEvent } from './types';

export interface OpenClawAdapterConfig {
  /** Hook into message_send tool calls */
  messageTool?: (params: any) => Promise<any>;
  /** Hook into sessions_send tool calls */
  sessionsTool?: (params: any) => Promise<any>;
}

/**
 * OpenClaw adapter — hooks message_send / sessions_send tool listeners
 * and normalizes into {type:'message', data:{content, channel, sender}, source:'openclaw'}
 */
export class OpenClawAdapter extends EventEmitter implements USRCPAdapter {
  readonly name = 'openclaw';
  private config: OpenClawAdapterConfig;
  private _origMessageTool?: (params: any) => Promise<any>;
  private _origSessionsTool?: (params: any) => Promise<any>;

  constructor(config: OpenClawAdapterConfig = {}) {
    super();
    this.config = config;
  }

  start(): void {
    // Wrap message_send tool to intercept calls
    if (this.config.messageTool) {
      this._origMessageTool = this.config.messageTool;
      const self = this;
      this.config.messageTool = async function wrappedMessageTool(params: any) {
        const result = await self._origMessageTool!(params);
        const event: USRCPEvent = {
          type: 'message',
          data: {
            content: params.content || params.message || result,
            channel: params.target || params.channel || 'default',
            sender: params.sender || 'openclaw',
          },
          source: 'openclaw',
          timestamp: new Date().toISOString(),
        };
        self.emit('event', event);
        return result;
      };
    }

    // Wrap sessions_send tool
    if (this.config.sessionsTool) {
      this._origSessionsTool = this.config.sessionsTool;
      const self = this;
      this.config.sessionsTool = async function wrappedSessionsTool(params: any) {
        const result = await self._origSessionsTool!(params);
        const event: USRCPEvent = {
          type: 'message',
          data: {
            content: params.content || params.message || result,
            channel: params.sessionId || params.target || 'session',
            sender: params.sender || 'openclaw',
          },
          source: 'openclaw',
          timestamp: new Date().toISOString(),
        };
        self.emit('event', event);
        return result;
      };
    }
  }

  /** Manually push an event (for external hook integration) */
  push(data: { content: string; channel?: string; sender?: string }): void {
    const event: USRCPEvent = {
      type: 'message',
      data: {
        content: data.content,
        channel: data.channel || 'default',
        sender: data.sender || 'openclaw',
      },
      source: 'openclaw',
      timestamp: new Date().toISOString(),
    };
    this.emit('event', event);
  }

  stop(): void {
    // Restore original tools
    if (this._origMessageTool) {
      this.config.messageTool = this._origMessageTool;
    }
    if (this._origSessionsTool) {
      this.config.sessionsTool = this._origSessionsTool;
    }
    this.removeAllListeners();
  }
}
