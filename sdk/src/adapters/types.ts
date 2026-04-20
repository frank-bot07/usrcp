import { EventEmitter } from 'events';

/** Normalized USRCP event — every adapter emits this shape */
export interface USRCPEvent {
  type: 'message' | 'webhook' | 'completion' | 'session' | string;
  data: Record<string, any>;
  source: 'openclaw' | 'hermes' | 'claude' | 'codex' | string;
  timestamp: string;
}

/** Every adapter extends EventEmitter and implements this interface */
export interface USRCPAdapter extends EventEmitter {
  readonly name: string;
  /** Start listening — called automatically by initLedger */
  start(): void;
  /** Stop listening and clean up */
  stop(): void;
}
